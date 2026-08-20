import { afterEach, describe, expect, it } from 'vitest';
import { BudgetLedger } from './budget';
import { InMemoryBudgetStoreAdapter } from './budget-store';
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
    await budgetStore.open({ workspaceId: 'workspace-1', accountKey: 'run-1', capCents: 1 });
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
