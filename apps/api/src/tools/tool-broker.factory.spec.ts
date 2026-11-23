import { paidOperationKey } from "../site-builder/site-build-cost-ledger";
import { createSmtpRcptProbeTool } from "./builtin-tools";
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetLedger, InMemoryBudgetStoreAdapter } from '@global/test-support';
import { buildToolBroker } from './tool-broker.factory';
import { RateLimiter } from './rate-limiter';

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
      limiter: new RateLimiter(),
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


describe('original SMTP step gate in the real Broker factory', () => {
  const input = { domain: 'company.example.invalid', mxHost: 'mx.company.example.invalid', rcptTo: ['person@company.example.invalid', 'x-verify-0123456789abcdef0123@company.example.invalid'] };
  it('composes only the original SMTP producer with a fake protocol and one final step gate', async () => {
    const events: string[] = [];
    const smtpProtocol = { resolveMxHost: vi.fn(async () => { events.push('PUBLIC_IP_FAKE'); return { safe: true, ip: '93.184.216.34' }; }), executeSmtpProbe: vi.fn(async () => { events.push('SMTP_FAKE'); return { reachable: true, mailFromCode: 250, codes: [250, 550] }; }) };
    const budgets = new InMemoryBudgetStoreAdapter(new BudgetLedger()); const reserve = vi.spyOn(budgets, 'reserve');
    const broker = buildToolBroker({ budgetStore: budgets, limiter: new RateLimiter(), smtpProtocol });
    const beforePhysicalWire = vi.fn(async () => { events.push('STEP_CLAIM_COMMITTED_FAKE'); });
    const result = await broker.invoke('smtp.rcpt_probe', input, { workspaceId: '00000000-0000-4000-8000-000000000001', runId: 'actual-account-key', purpose: 'enrichment', authorizeExternalAction: async () => true, beforePhysicalWire });
    expect(events).toEqual(['PUBLIC_IP_FAKE', 'STEP_CLAIM_COMMITTED_FAKE', 'SMTP_FAKE']); expect(beforePhysicalWire).toHaveBeenCalledTimes(1); expect(smtpProtocol.executeSmtpProbe).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ accountKey: 'actual-account-key', estimatedMicrousd: 0n, operationKey: paidOperationKey(['actual-account-key', 'tool-budget', 'smtp.rcpt_probe', '1.0.0', createSmtpRcptProbeTool(smtpProtocol).idempotencyKey(input)]) }));
    expect(result.data).toMatchObject({ reachable: true, codes: [250, 550] }); expect(result.costCents).toBe(0);
  });
  it('fails before SMTP transport when the step claim rejects and never falls back to default network', async () => {
    const smtpProtocol = { resolveMxHost: vi.fn(async () => ({ safe: true, ip: '93.184.216.34' })), executeSmtpProbe: vi.fn() };
    const broker = buildToolBroker({ budgetStore: new InMemoryBudgetStoreAdapter(new BudgetLedger()), limiter: new RateLimiter(), smtpProtocol });
    await expect(broker.invoke('smtp.rcpt_probe', input, { workspaceId: '00000000-0000-4000-8000-000000000001', runId: 'actual-account-key', purpose: 'enrichment', beforePhysicalWire: async () => { throw new Error('synthetic_current_claim_denial'); } })).rejects.toThrow();
    expect(smtpProtocol.executeSmtpProbe).not.toHaveBeenCalled();
  });
});
