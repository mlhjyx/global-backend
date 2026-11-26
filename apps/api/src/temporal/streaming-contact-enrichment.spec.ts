import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionBudgetBinding } from '../execution-budget/execution-budget-binding';
import {
  enrichMatchedStreamingCompany,
  resolveStreamingContactDiscoveryLawfulBasis,
} from './streaming-contact-enrichment';

const claim = vi.hoisted(() => vi.fn(async (_db, _scope, execute: () => Promise<unknown>) => {
  await execute();
}));
vi.mock('../enrichment/safety/streaming-contact-enrichment-results', () => ({
  runBypassStreamingContactEnrichment: claim,
}));

const configured = { lawfulBasis: { basis: 'legitimate_interest', ref: 'decision-maker-policy' } };
const workspaceId = '10000000-0000-4000-8000-000000000001';
const runId = '20000000-0000-4000-8000-000000000002';
const companyId = '30000000-0000-4000-8000-000000000003';
const requestSha256 = 'a'.repeat(64);
const binding: ExecutionBudgetBinding = {
  authorityId: '40000000-0000-4000-8000-000000000004', replay: false, scopeKey: workspaceId,
  accountKey: ['discovery.run', 'discovery_run', runId, requestSha256].join(':'),
  purpose: 'discovery.run', subjectType: 'discovery_run', subjectId: runId, requestSha256,
};

describe('流式联系人合法依据读取', () => {
  it('按现有配置对象或 JSON 环境变量读取明确的依据', () => {
    const source = { lawfulBasis: { basis: 'legitimate_interest', ref: 'explicit-fixture' } };
    expect(resolveStreamingContactDiscoveryLawfulBasis(undefined, configured)).toEqual(configured.lawfulBasis);
    expect(resolveStreamingContactDiscoveryLawfulBasis(JSON.stringify(source), configured)).toEqual(source.lawfulBasis);
    expect(resolveStreamingContactDiscoveryLawfulBasis(JSON.stringify(source.lawfulBasis), configured)).toEqual(source.lawfulBasis);
    expect(resolveStreamingContactDiscoveryLawfulBasis('legitimate_interest', configured)).toEqual({ basis: 'legitimate_interest' });
  });

  it('拒绝无效显式设置并且默认关停无授权目录', () => {
    expect(resolveStreamingContactDiscoveryLawfulBasis('{"lawfulBasis":', configured)).toBeUndefined();
    expect(resolveStreamingContactDiscoveryLawfulBasis('{"lawfulBasis":{"basis":"unsafe"}}', configured)).toBeUndefined();
    expect(resolveStreamingContactDiscoveryLawfulBasis(undefined, null)).toBeUndefined();
  });
});

describe('流式匹配公司进入 F7', () => {
  beforeEach(() => { claim.mockClear(); });
  afterEach(() => { vi.unstubAllEnvs(); });

  function fixture() {
    const findFirst = vi.fn(async (): Promise<{ contactEnrichmentStatus: string | null } | null> =>
      ({ contactEnrichmentStatus: null }));
    const executeRun = vi.fn(async () => ({
      admission: 'ADMITTED', tier: 'B', attempted: 1, costMicrousd: 0, rateLimited: true, results: [],
    }));
    const status = vi.fn(async () => ({ remainingMicrousd: 50000n }));
    const deps = {
      prisma: {
        withWorkspace: async (_ws: string, fn: (tx: unknown) => Promise<unknown>) =>
          fn({ discoveryCompanyJob: { findFirst } }),
      },
      safety: { executeRun },
      budgetStore: { status },
    };
    return { deps: deps as never, executeRun, findFirst, status };
  }

  it('在旁路用可重放的公司作业包装原执行，并传入同一个 run 的绑定', async () => {
    vi.stubEnv('LEGACY_EXECUTION_BUDGET_MODE', 'bypass');
    const f = fixture();
    await enrichMatchedStreamingCompany(f.deps, {
      workspaceId, runId, companyId, binding, enrichmentSlot: 0, providerConfig: configured,
    });
    expect(f.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId, runId, canonicalCompanyId: companyId, verdictDeep: 'match', run: { status: 'RUNNING' } },
    }));
    expect(claim).toHaveBeenCalledWith(expect.anything(), { workspaceId, runId, companyId }, expect.any(Function));
    expect(f.status).toHaveBeenCalledWith({ workspaceId, accountKey: binding.accountKey });
    expect(f.executeRun).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId, companyId, businessRunId: runId, binding, remainingMicrousd: '50000',
      lawfulBasis: expect.objectContaining(configured.lawfulBasis),
    }));
  });

  it('拒绝无顺位、越界、无批准依据或未强匹配的作业', async () => {
    const f = fixture();
    const base = { workspaceId, runId, companyId, binding, providerConfig: configured };
    for (const enrichmentSlot of [undefined, -1, 25, 0.5]) {
      await enrichMatchedStreamingCompany(f.deps, { ...base, enrichmentSlot });
    }
    await enrichMatchedStreamingCompany(f.deps, { ...base, enrichmentSlot: 0, providerConfig: null });
    expect(f.findFirst).not.toHaveBeenCalled();
    f.findFirst.mockResolvedValueOnce(null);
    await enrichMatchedStreamingCompany(f.deps, { ...base, enrichmentSlot: 0 });
    expect(f.executeRun).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it('旧兼容模式沿用 F7 原持久执行入口', async () => {
    vi.stubEnv('LEGACY_EXECUTION_BUDGET_MODE', 'enforce');
    const f = fixture();
    await enrichMatchedStreamingCompany(f.deps, {
      workspaceId, runId, companyId, binding, enrichmentSlot: 0, providerConfig: configured,
    });
    expect(f.executeRun).toHaveBeenCalledOnce();
    expect(claim).not.toHaveBeenCalled();
  });

  it('切回旧兼容模式后仍保留同一轮已认领的旁路操作', async () => {
    vi.stubEnv('LEGACY_EXECUTION_BUDGET_MODE', 'enforce');
    const f = fixture();
    f.findFirst.mockResolvedValueOnce({ contactEnrichmentStatus: 'RATE_LIMITED' });
    await enrichMatchedStreamingCompany(f.deps, {
      workspaceId, runId, companyId, binding, enrichmentSlot: 0, providerConfig: configured,
    });
    expect(f.executeRun).not.toHaveBeenCalled();
  });
});
