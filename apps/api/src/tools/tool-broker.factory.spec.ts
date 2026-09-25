import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetLedger, InMemoryBudgetStoreAdapter } from '@global/test-support';
import { buildToolBroker } from './tool-broker.factory';

const originalToolRedisUrl = process.env.TOOL_RATE_LIMIT_REDIS_URL;
const originalRedisUrl = process.env.REDIS_URL;

afterEach(() => {
  if (originalToolRedisUrl === undefined) delete process.env.TOOL_RATE_LIMIT_REDIS_URL;
  else process.env.TOOL_RATE_LIMIT_REDIS_URL = originalToolRedisUrl;
  if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = originalRedisUrl;
});

describe('buildToolBroker Redis composition', () => {
  it('fails closed without constructing a remote plaintext or option-bearing Redis client', async () => {
    const configured = 'redis://user:must-not-leak@cache.example.test:6379/0?tls=false';
    process.env.TOOL_RATE_LIMIT_REDIS_URL = configured;
    delete process.env.REDIS_URL;
    const budgetStore = new InMemoryBudgetStoreAdapter(new BudgetLedger());
    const broker = buildToolBroker({ budgetStore });

    const call = broker.invoke(
      'searxng.search',
      { q: 'must not execute' },
      { workspaceId: 'workspace-1', runId: 'run-1' },
    );
    await expect(call).rejects.toMatchObject({
      code: 'RATE_LIMIT_STORE_UNAVAILABLE',
      message: 'Redis rate-limit configuration invalid',
    });
    await expect(call).rejects.not.toThrow('must-not-leak');
  });
});

describe('buildToolBroker artifact composition (G3 5.1)', () => {
  it('holds a subject-bound fetch before any wire when no artifact storage is composed', async () => {
    delete process.env.TOOL_RATE_LIMIT_REDIS_URL;
    delete process.env.REDIS_URL;
    const broker = buildToolBroker({
      budgetStore: new InMemoryBudgetStoreAdapter(new BudgetLedger()),
    });
    await expect(broker.invoke(
      'crawl4ai.fetch',
      { url: 'https://pumpen.example/' },
      {
        workspaceId: '00000000-0000-4000-8000-0000000000a1',
        runId: 'run-1',
        artifactSubject: { subjectType: 'company', subjectId: '00000000-0000-4000-8000-0000000000c3' },
      },
    )).rejects.toMatchObject({
      name: 'ToolPolicyDenied',
      reason: 'GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE',
    });
  });

  it('routes a subject-bound fetch through an injected artifact execution port', async () => {
    delete process.env.TOOL_RATE_LIMIT_REDIS_URL;
    delete process.env.REDIS_URL;
    const admit = vi.fn(async () => ({ status: 'DENIED' as const, reason: 'SUBJECT_SUPPRESSED' as const }));
    const broker = buildToolBroker({
      budgetStore: new InMemoryBudgetStoreAdapter(new BudgetLedger()),
      artifactExecution: { admit, persist: vi.fn(), replay: vi.fn() },
    });
    await expect(broker.invoke(
      'crawl4ai.fetch',
      { url: 'https://pumpen.example/' },
      {
        workspaceId: '00000000-0000-4000-8000-0000000000a1',
        runId: 'run-1',
        artifactSubject: { subjectType: 'company', subjectId: '00000000-0000-4000-8000-0000000000c3' },
      },
    )).rejects.toMatchObject({ reason: 'GENERIC_OPERATION_ARTIFACT_SUBJECT_SUPPRESSED' });
    expect(admit).toHaveBeenCalledOnce();
  });
});
