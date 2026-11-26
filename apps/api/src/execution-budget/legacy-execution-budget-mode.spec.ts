import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import type { ModelProvider } from '../model-gateway/model-provider';
import { ModelProviderRegistry } from '../model-gateway/model-provider.registry';
import { ModelRouter } from '../model-gateway/model-router';
import { RouterModelGateway } from '../model-gateway/router-model-gateway';
import type { AiTraceSink } from '../model-gateway/ai-trace.sink';
import type { ModelResult } from '../model-gateway/types';
import { ToolBroker, ToolPolicyDenied } from '../tools/tool-broker';
import { ToolRegistry } from '../tools/tool-registry';
import type { Tool } from '../tools/tool-contract';
import { RateLimiter } from '../tools/rate-limiter';
import {
  BudgetStoreUnavailableError,
  PostgresBudgetStore,
  UnavailableBudgetStore,
} from '../tools/budget-store';
import { checkExecutionBudgetJwksReadiness } from '../runtime/managed-dependency-readiness';
import {
  assertFreshExecutionBudgetBinding,
  ExecutionBudgetAuthorityService,
} from './execution-budget-authority.service';
import { ExecutionBudgetAuthorityRepository } from './execution-budget-authority.repository';
import { ExecutionBudgetGrantVerifier } from './execution-budget-grant.verifier';
import { ExecutionBudgetGrantError } from './execution-budget-authority.types';
import { parseExecutionBudgetBinding } from './execution-budget-binding';
import {
  assertStatelessModelCallLimits,
  assertStatelessTaskCallBudget,
  BYPASS_MARKET_GENERATION_CAP_MICROUSD,
  BYPASS_TECHNICAL_CAP_MICROUSD,
  createWorkspaceBudgetStore,
  isLegacyExecutionBudgetBypass,
  LEGACY_EXECUTION_BUDGET_MODE_ENV,
  resolveLegacyExecutionBudgetMode,
  STATELESS_TASK_HARD_LIMITS,
  StatelessTechnicalBudgetStore,
  TechnicalTaskLimitExceededError,
} from './legacy-execution-budget-mode';

const WORKSPACE_ID = 'e03abddd-1307-47cb-a731-7e7a786615a0';
const AUTHORITY_ID = '42c863b9-7c7e-4d28-8678-60ef9a20219b';
const COMPANY_ID = 'f5ba98f2-a0e2-4e85-b799-e85568877702';
const REQUEST_SHA256 = 'a'.repeat(64);

function sampleTool(id = 'searxng.search', policyMode: 'none' | 'required' = 'none'): Tool {
  return {
    id,
    version: '1.0.0',
    category: 'search',
    cost: { unit: 'call', estimatedCents: 1, external: false },
    rateLimit: { rps: 100, concurrency: 5 },
    compliance: {
      sourcePolicy: policyMode,
      ...(policyMode === 'required' ? { policyDomain: 'example.com' } : {}),
      respectsRobots: false,
      personalData: false,
      allowedPurpose: ['discovery'],
      reversible: true,
      authRequired: false,
      risk: 'low',
    },
    capabilities: { produces: ['domain'], accepts: ['keywords'] },
    idempotencyKey: (input: unknown) => `${id}:${JSON.stringify(input ?? {})}`,
    durableResultStrategy: { kind: 'no_physical_call' },
    healthCheck: async () => ({ healthy: true }),
    execute: async () => ({ data: { ok: true }, costCents: 1 }),
  };
}

function fakeModelProvider(
  impl?: () => Promise<ModelResult<unknown>>,
): ModelProvider {
  return {
    id: 'fake-new-api',
    supports: () => true,
    health: async () => ({ healthy: true }),
    generateText: vi.fn(
      async () =>
        (await impl?.()) ?? {
          data: 'hello',
          provider: 'fake-new-api',
          model: 'deepseek-v3',
          usage: { inputTokens: 120, outputTokens: 80, costUsd: 0.002 },
        },
    ),
    generateStructured: vi.fn(
      async () =>
        (await impl?.()) ?? {
          data: { ok: true },
          provider: 'fake-new-api',
          model: 'deepseek-v3',
          usage: { inputTokens: 200, outputTokens: 100, costUsd: 0.005 },
        },
    ),
    reviewVision: vi.fn(),
    embed: vi.fn(async () => ({
      data: [[0.1, 0.2]],
      provider: 'fake-new-api',
      model: 'bge-m3',
      usage: { inputTokens: 10, outputTokens: 0 },
    })),
  } as unknown as ModelProvider;
}

describe('LEGACY_EXECUTION_BUDGET_MODE (enforce | bypass)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('mode resolution and stateless hard-limit guards', () => {
    it('defaults to enforce and fails closed to enforce on malformed values', () => {
      expect(resolveLegacyExecutionBudgetMode({})).toBe('enforce');
      expect(resolveLegacyExecutionBudgetMode({ [LEGACY_EXECUTION_BUDGET_MODE_ENV]: '' })).toBe('enforce');
      expect(resolveLegacyExecutionBudgetMode({ [LEGACY_EXECUTION_BUDGET_MODE_ENV]: 'enforce' })).toBe('enforce');
      expect(resolveLegacyExecutionBudgetMode({ [LEGACY_EXECUTION_BUDGET_MODE_ENV]: 'ENFORCE' })).toBe('enforce');
      expect(resolveLegacyExecutionBudgetMode({ [LEGACY_EXECUTION_BUDGET_MODE_ENV]: 'off' })).toBe('enforce');
      expect(resolveLegacyExecutionBudgetMode({ [LEGACY_EXECUTION_BUDGET_MODE_ENV]: 'true' })).toBe('enforce');
      expect(resolveLegacyExecutionBudgetMode({ [LEGACY_EXECUTION_BUDGET_MODE_ENV]: 'bypass' })).toBe('bypass');
      expect(resolveLegacyExecutionBudgetMode({ [LEGACY_EXECUTION_BUDGET_MODE_ENV]: '  BYPASS ' })).toBe('bypass');
      expect(isLegacyExecutionBudgetBypass({ [LEGACY_EXECUTION_BUDGET_MODE_ENV]: 'bypass' })).toBe(true);
      expect(isLegacyExecutionBudgetBypass({})).toBe(false);
    });

    it('enforces stateless model token ceilings and per-task call ceilings', () => {
      expect(STATELESS_TASK_HARD_LIMITS.maxPlanQueries).toBeGreaterThan(0);
      expect(STATELESS_TASK_HARD_LIMITS.maxDiscoveryCompanies).toBeGreaterThan(0);
      expect(STATELESS_TASK_HARD_LIMITS.maxContactsPerRequest).toBeGreaterThan(0);
      expect(STATELESS_TASK_HARD_LIMITS.maxModelOutputTokens).toBe(32_768);

      expect(() =>
        assertStatelessModelCallLimits({
          taskId: 'icp.design',
          maxTokens: 4_000,
          taskMaxOutputTokens: 8_000,
        }),
      ).not.toThrow();

      expect(() =>
        assertStatelessModelCallLimits({
          taskId: 'icp.design',
          maxTokens: 9_000,
          taskMaxOutputTokens: 8_000,
        }),
      ).toThrow(TechnicalTaskLimitExceededError);

      expect(() =>
        assertStatelessModelCallLimits({
          taskId: 'custom.task',
          maxTokens: STATELESS_TASK_HARD_LIMITS.maxModelOutputTokens + 1,
        }),
      ).toThrow(TechnicalTaskLimitExceededError);

      expect(() => assertStatelessTaskCallBudget('tool', 2, 2)).not.toThrow();
      expect(() => assertStatelessTaskCallBudget('tool', 3, 2)).toThrow(
        TechnicalTaskLimitExceededError,
      );
      expect(() => assertStatelessTaskCallBudget('model', 3, 2)).toThrow(
        TechnicalTaskLimitExceededError,
      );
    });

    it('switches createWorkspaceBudgetStore between PostgresBudgetStore (enforce) and StatelessTechnicalBudgetStore (bypass)', () => {
      const fakePrisma = {} as PrismaService;
      expect(createWorkspaceBudgetStore(fakePrisma, {})).toBeInstanceOf(
        PostgresBudgetStore,
      );
      expect(
        createWorkspaceBudgetStore(fakePrisma, {
          [LEGACY_EXECUTION_BUDGET_MODE_ENV]: 'enforce',
        }),
      ).toBeInstanceOf(PostgresBudgetStore);
      expect(
        createWorkspaceBudgetStore(fakePrisma, {
          [LEGACY_EXECUTION_BUDGET_MODE_ENV]: 'bypass',
        }),
      ).toBeInstanceOf(StatelessTechnicalBudgetStore);
    });
  });

  describe('StatelessTechnicalBudgetStore', () => {
    it('supports open/attest/reserve/settle/release/status/close with zero DB calls and enforces per-account operation limit', async () => {
      const store = new StatelessTechnicalBudgetStore({
        maxOperationsPerAccount: 2,
      });
      const accountKey = `icp.design:company:${COMPANY_ID}:${REQUEST_SHA256}`;

      const opened = await store.open({
        authorityId: AUTHORITY_ID,
        scopeKey: WORKSPACE_ID,
        accountKey,
      });
      expect(opened.authorityId).toBe(AUTHORITY_ID);
      expect(opened.authorizedCapMicrousd).toBe(BYPASS_TECHNICAL_CAP_MICROUSD);

      const attested = await store.attestAuthorized({
        authorityId: AUTHORITY_ID,
        scopeKey: WORKSPACE_ID,
        accountKey,
      });
      expect(attested.authorityId).toBe(AUTHORITY_ID);

      const r1 = await store.reserve({
        workspaceId: WORKSPACE_ID,
        accountKey,
        operationKey: 'op-1',
        estimatedMicrousd: 100n,
      });
      expect(r1.replay).toBe(false);
      const settled = await store.settle(r1, 50n);
      expect(settled.chargedMicrousd).toBe(50n);

      const r2 = await store.reserve({
        workspaceId: WORKSPACE_ID,
        accountKey,
        operationKey: 'op-2',
        estimatedMicrousd: 100n,
      });
      const released = await store.release(r2);
      expect(released.chargedMicrousd).toBe(0n);

      await expect(
        store.reserve({
          workspaceId: WORKSPACE_ID,
          accountKey,
          operationKey: 'op-3',
          estimatedMicrousd: 100n,
        }),
      ).rejects.toThrow(TechnicalTaskLimitExceededError);

      expect(
        await store.status({ workspaceId: WORKSPACE_ID, accountKey }),
      ).toEqual({
        remainingMicrousd: BYPASS_TECHNICAL_CAP_MICROUSD,
        exhausted: false,
        open: true,
      });

      await store.close({ workspaceId: WORKSPACE_ID, accountKey });
      await expect(
        store.reserve({
          workspaceId: WORKSPACE_ID,
          accountKey,
          operationKey: 'op-after-close',
          estimatedMicrousd: 100n,
        }),
      ).resolves.toMatchObject({ replay: false });
    });

    it('rejects platform scope so platform schedules cannot bypass', async () => {
      const store = new StatelessTechnicalBudgetStore();
      await expect(
        store.attestAuthorized({
          authorityId: AUTHORITY_ID,
          scopeKey: 'platform',
          accountKey: 'platform:schedule',
        }),
      ).rejects.toMatchObject({ code: 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH' });

      await expect(
        store.reserve({
          workspaceId: 'platform',
          accountKey: 'platform:schedule',
          operationKey: 'op-1',
          estimatedMicrousd: 10n,
        }),
      ).rejects.toMatchObject({ code: 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH' });
    });
  });

  describe('ExecutionBudgetAuthorityService dual-mode behavior', () => {
    it('enforces RS256 verification, repository consumption, and 409 GRANT_REUSED in enforce mode', async () => {
      vi.stubEnv(LEGACY_EXECUTION_BUDGET_MODE_ENV, 'enforce');
      const verify = vi
        .fn()
        .mockRejectedValue(
          new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_REQUIRED'),
        );
      const consumeWorkspaceAndOpen = vi.fn();
      const service = new ExecutionBudgetAuthorityService(
        { verify } as unknown as ExecutionBudgetGrantVerifier,
        { consumeWorkspaceAndOpen } as unknown as ExecutionBudgetAuthorityRepository,
      );

      await expect(
        service.verifyWorkspaceGrant({
          compactJws: undefined,
          identity: { workspaceId: WORKSPACE_ID },
          scope: {
            purpose: 'icp.design',
            subjectType: 'company',
            subjectId: COMPANY_ID,
            requestSha256: REQUEST_SHA256,
          },
        }),
      ).rejects.toMatchObject({ code: 'EXECUTION_BUDGET_GRANT_REQUIRED' });
      expect(verify).toHaveBeenCalledTimes(1);
      expect(consumeWorkspaceAndOpen).not.toHaveBeenCalled();
    });

    it('skips RS256 verification and DB writes in bypass mode and never triggers 409 GRANT_REUSED on retries', async () => {
      vi.stubEnv(LEGACY_EXECUTION_BUDGET_MODE_ENV, 'bypass');
      const verify = vi.fn().mockRejectedValue(new Error('must not be called'));
      const consumeWorkspaceAndOpen = vi
        .fn()
        .mockRejectedValue(new Error('must not be called'));
      const consumeWorkspaceAndOpenInTransaction = vi
        .fn()
        .mockRejectedValue(new Error('must not be called'));
      const service = new ExecutionBudgetAuthorityService(
        { verify } as unknown as ExecutionBudgetGrantVerifier,
        {
          consumeWorkspaceAndOpen,
          consumeWorkspaceAndOpenInTransaction,
        } as unknown as ExecutionBudgetAuthorityRepository,
      );

      const requestScope = {
        purpose: 'icp.design' as const,
        subjectType: 'company',
        subjectId: COMPANY_ID,
        requestSha256: REQUEST_SHA256,
      };

      const first = await service.consumeWorkspaceGrant({
        compactJws: undefined,
        identity: { workspaceId: WORKSPACE_ID },
        scope: requestScope,
      });
      const second = await service.consumeWorkspaceGrant({
        compactJws: undefined,
        identity: { workspaceId: WORKSPACE_ID },
        scope: requestScope,
      });
      const verified = await service.verifyWorkspaceGrant({
        compactJws: undefined,
        identity: { workspaceId: WORKSPACE_ID },
        scope: requestScope,
      });
      const inTx = await service.consumeVerifiedWorkspaceGrantInTransaction(
        verified,
        {} as never,
      );

      expect(verify).not.toHaveBeenCalled();
      expect(consumeWorkspaceAndOpen).not.toHaveBeenCalled();
      expect(consumeWorkspaceAndOpenInTransaction).not.toHaveBeenCalled();

      expect(() => assertFreshExecutionBudgetBinding(first)).not.toThrow();
      expect(() => assertFreshExecutionBudgetBinding(second)).not.toThrow();
      expect(() => assertFreshExecutionBudgetBinding(inTx)).not.toThrow();
      expect(first.authorityId).not.toBe(second.authorityId);

      // Output binding must stay structurally compatible with Temporal workflow parsers.
      expect(
        parseExecutionBudgetBinding(first, {
          scopeKey: WORKSPACE_ID,
          purpose: 'icp.design',
          subjectType: 'company',
        }),
      ).toEqual(first);

      // market.candidates.generate keeps its structural cap compatibility.
      const marketVerified = await service.verifyWorkspaceGrant({
        compactJws: undefined,
        identity: { workspaceId: WORKSPACE_ID },
        scope: {
          purpose: 'market.candidates.generate',
          subjectType: 'market_candidate_generation',
          subjectId: COMPANY_ID,
          requestSha256: REQUEST_SHA256,
        },
      });
      expect(marketVerified.capMicrousd).toBe(
        BYPASS_MARKET_GENERATION_CAP_MICROUSD,
      );

      // Invalid workspaceId still fails closed even in bypass mode.
      await expect(
        service.verifyWorkspaceGrant({
          compactJws: undefined,
          identity: { workspaceId: 'not-a-uuid' },
          scope: requestScope,
        }),
      ).rejects.toMatchObject({
        code: 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH',
      });
    });
  });

  describe('ToolBroker dual-mode behavior', () => {
    it('requires authoritative BudgetStore in enforce mode', async () => {
      const registry = new ToolRegistry();
      registry.register(sampleTool());
      const broker = new ToolBroker({
        registry,
        budgetStore: new UnavailableBudgetStore(),
        limiter: new RateLimiter(),
        legacyBudgetMode: 'enforce',
      });

      await expect(
        broker.invoke('searxng.search', { q: 'valves' }, { workspaceId: WORKSPACE_ID }),
      ).rejects.toThrow(BudgetStoreUnavailableError);
    });

    it('skips BudgetStore writes in bypass mode while keeping rate limit, source_policy, suppression gate, trace, and per-task call limit', async () => {
      const registry = new ToolRegistry();
      registry.register(sampleTool('searxng.search', 'none'));
      registry.register(sampleTool('gleif.fetch', 'required'));
      const traces: Array<{ status: string; toolId: string; reason?: string }> = [];
      const limiter = new RateLimiter();
      const acquireSpy = vi.spyOn(limiter, 'acquire');

      const broker = new ToolBroker({
        registry,
        budgetStore: new UnavailableBudgetStore('must not be called in bypass'),
        limiter,
        sourcePolicyReader: async () => ({ suspended: true }),
        traceRecorder: (t) => traces.push({ status: t.status, toolId: t.toolId, reason: t.reason }),
        legacyBudgetMode: 'bypass',
        maxBypassToolCallsPerAccount: 2,
      });

      // 1) source_policy SUSPENDED still blocks before execution.
      await expect(
        broker.invoke(
          'gleif.fetch',
          { domain: 'example.com' },
          { workspaceId: WORKSPACE_ID, runId: 'run-1' },
        ),
      ).rejects.toThrow(ToolPolicyDenied);

      // 2) Workspace calls bypass BudgetStore completely, keep rate limiter + trace.
      const res1 = await broker.invoke(
        'searxng.search',
        { q: 'pump' },
        { workspaceId: WORKSPACE_ID, runId: 'run-1' },
      );
      expect(res1.data).toEqual({ ok: true });
      expect(acquireSpy).toHaveBeenCalledWith('searxng.search', expect.any(Number));

      // 3) Suppression gate still blocks in bypass mode.
      await expect(
        broker.invoke(
          'searxng.search',
          { q: 'suppressed' },
          {
            workspaceId: WORKSPACE_ID,
            runId: 'run-1',
            authorizeExternalAction: async () => false,
          },
        ),
      ).rejects.toThrow(ToolPolicyDenied);

      // 4) Per-task stateless hard ceiling stops runaway loops (3rd call for run-1 exceeds max=2).
      await expect(
        broker.invoke(
          'searxng.search',
          { q: 'runaway' },
          { workspaceId: WORKSPACE_ID, runId: 'run-1' },
        ),
      ).rejects.toThrow(TechnicalTaskLimitExceededError);

      // 5) Platform workspace NEVER bypasses BudgetStore (even with platformEgress fence).
      await expect(
        broker.invoke(
          'searxng.search',
          { q: 'platform' },
          {
            workspaceId: 'platform',
            runId: 'plat-1',
            platformEgress: {
              authorizeAndDispatch: async (_op, run) => run(),
            },
          },
        ),
      ).rejects.toThrow(BudgetStoreUnavailableError);

      expect(traces.some((t) => t.status === 'OK' && t.toolId === 'searxng.search')).toBe(true);
      expect(traces.some((t) => t.status === 'DENIED' && t.reason?.includes('technical limit exceeded'))).toBe(true);
    });
  });

  describe('RouterModelGateway dual-mode behavior', () => {
    function makeGateway(provider: ModelProvider, traceRecord = vi.fn()) {
      const registry = new ModelProviderRegistry();
      registry.register(provider);
      const router = new ModelRouter(registry);
      const trace = { record: traceRecord } as unknown as AiTraceSink;
      const gateway = new RouterModelGateway(
        router,
        trace,
        new UnavailableBudgetStore('must not be called in bypass'),
      );
      return { gateway, traceRecord };
    }

    it('requires authoritative BudgetStore in enforce mode', async () => {
      const { gateway } = makeGateway(fakeModelProvider());
      gateway.legacyBudgetMode = 'enforce';
      await expect(
        gateway.generateText(
          { task: 'discovery.qualify_fit', prompt: 'hi' },
          { workspaceId: WORKSPACE_ID, runId: 'run-enforce' },
        ),
      ).rejects.toThrow(BudgetStoreUnavailableError);
    });

    it('bypasses BudgetStore writes in bypass mode while keeping ai_trace/usage_ledger recording, token ceiling, call ceiling, and platform guard', async () => {
      const provider = fakeModelProvider();
      const traceRecord = vi.fn();
      const { gateway } = makeGateway(provider, traceRecord);
      gateway.legacyBudgetMode = 'bypass';
      gateway.maxBypassModelCallsPerAccount = 2;

      const textRes = await gateway.generateText(
        { task: 'discovery.qualify_fit', prompt: 'hello', maxTokens: 512 },
        { workspaceId: WORKSPACE_ID, runId: 'run-bypass' },
      );
      expect(textRes.data).toBe('hello');
      expect(traceRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: WORKSPACE_ID,
          task: 'discovery.qualify_fit',
          status: 'OK',
          inputTokens: 120,
          outputTokens: 80,
          costUsd: 0.002,
        }),
      );

      // Cached structured settlement also bypasses BudgetStore and records lightweight trace.
      const cached = await gateway.settleCachedStructured(
        { task: 'discovery.qualify_fit', prompt: 'p', schema: { type: 'object' } },
        { workspaceId: WORKSPACE_ID, runId: 'run-bypass' },
        { data: { ok: true }, model: 'deepseek-v3' },
      );
      expect(cached.provider).toBe('llm-cache');
      expect(traceRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'llm-cache',
          status: 'OK',
          costUsd: 0,
        }),
      );

      // maxTokens above technical hard ceiling is rejected before provider dispatch.
      await expect(
        gateway.generateText(
          {
            task: 'discovery.qualify_fit',
            prompt: 'too many tokens',
            maxTokens: STATELESS_TASK_HARD_LIMITS.maxModelOutputTokens + 1,
          },
          { workspaceId: WORKSPACE_ID, runId: 'run-bypass' },
        ),
      ).rejects.toThrow(TechnicalTaskLimitExceededError);

      // Second real call succeeds; third exceeds maxBypassModelCallsPerAccount=2.
      await gateway.generateText(
        { task: 'discovery.qualify_fit', prompt: 'second' },
        { workspaceId: WORKSPACE_ID, runId: 'run-bypass' },
      );
      await expect(
        gateway.generateText(
          { task: 'discovery.qualify_fit', prompt: 'third' },
          { workspaceId: WORKSPACE_ID, runId: 'run-bypass' },
        ),
      ).rejects.toThrow(TechnicalTaskLimitExceededError);

      // Platform workspace NEVER bypasses BudgetStore (even with platformEgress fence).
      await expect(
        gateway.generateText(
          { task: 'discovery.qualify_fit', prompt: 'platform call' },
          {
            workspaceId: 'platform',
            runId: 'plat-run',
            platformEgress: {
              authorizeAndDispatch: async (_op, run) => run(),
            },
          },
        ),
      ).rejects.toThrow(BudgetStoreUnavailableError);
    });
  });

  describe('readiness probe dual-mode behavior', () => {
    it('skips execution budget JWKS probe in bypass mode and stays fail-closed in enforce mode', async () => {
      const fetcher = vi.fn();
      const enforceStatus = await checkExecutionBudgetJwksReadiness({}, fetcher);
      expect(enforceStatus).toEqual({
        status: 'failed',
        code: 'EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE',
      });

      const bypassStatus = await checkExecutionBudgetJwksReadiness(
        { [LEGACY_EXECUTION_BUDGET_MODE_ENV]: 'bypass' },
        fetcher,
      );
      expect(bypassStatus).toEqual({ status: 'ok' });
      expect(fetcher).not.toHaveBeenCalled();
    });
  });
});
