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
  type BudgetStore,
} from '../tools/budget-store';
import { buildToolBroker } from '../tools/tool-broker.factory';
import type { ArtifactExecutionPort } from '../tools/artifact-execution-port';
import {
  createBypassContactEnrichmentSafetyExecutor,
  createManagedContactEnrichmentSafety,
} from '../enrichment/safety/contact-enrichment-safety.composition';
import { executeContactEnrichmentSafetyActivity } from '../temporal/contact-enrichment-safety.activity';
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
  ScopeRoutedBypassBudgetStore,
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

    it('switches createWorkspaceBudgetStore between PostgresBudgetStore (enforce) and ScopeRoutedBypassBudgetStore (bypass)', () => {
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
      ).toBeInstanceOf(ScopeRoutedBypassBudgetStore);
    });
  });

  describe('ScopeRoutedBypassBudgetStore (platform durable vs workspace stateless)', () => {
    it('routes platform scope methods to PostgresBudgetStore while tenant UUIDs stay stateless with zero DB calls', async () => {
      const openSpy = vi
        .spyOn(PostgresBudgetStore.prototype, 'open')
        .mockResolvedValue({
          accountId: 'plat-acct-1',
          authorityId: AUTHORITY_ID,
          authorizedCapMicrousd: 500_000n,
          generation: 1,
        });
      const attestSpy = vi
        .spyOn(PostgresBudgetStore.prototype, 'attestAuthorized')
        .mockResolvedValue({
          accountId: 'plat-acct-1',
          authorityId: AUTHORITY_ID,
          authorizedCapMicrousd: 500_000n,
          generation: 1,
        });
      const reserveSpy = vi
        .spyOn(PostgresBudgetStore.prototype, 'reserve')
        .mockResolvedValue({
          workspaceId: 'platform',
          accountKey: 'platform:sanctions',
          operationId: 'plat-op-1',
          estimatedMicrousd: 100n,
          replay: false,
        });
      const settleSpy = vi
        .spyOn(PostgresBudgetStore.prototype, 'settle')
        .mockResolvedValue({
          chargedMicrousd: 80n,
          observedMicrousd: 80n,
          capVariance: false,
          replay: false,
        });
      const statusSpy = vi
        .spyOn(PostgresBudgetStore.prototype, 'status')
        .mockResolvedValue({
          remainingMicrousd: 499_920n,
          exhausted: false,
          open: true,
        });
      const closeSpy = vi
        .spyOn(PostgresBudgetStore.prototype, 'close')
        .mockResolvedValue(undefined);
      const releaseSpy = vi
        .spyOn(PostgresBudgetStore.prototype, 'release')
        .mockResolvedValue({
          chargedMicrousd: 0n,
          observedMicrousd: 0n,
          capVariance: false,
          replay: false,
        });

      try {
        const mockPrisma = {
          $transaction: vi.fn(() => {
            throw new Error('tenant bypass must not touch prisma');
          }),
          $queryRaw: vi.fn(() => {
            throw new Error('tenant bypass must not touch prisma');
          }),
        } as unknown as PrismaService;
        const store = createWorkspaceBudgetStore(mockPrisma, {
          [LEGACY_EXECUTION_BUDGET_MODE_ENV]: 'bypass',
        });

        // 1) Tenant workspace UUID -> stateless store, zero PostgresBudgetStore/Prisma calls.
        const wsOpened = await store.open({
          authorityId: AUTHORITY_ID,
          scopeKey: WORKSPACE_ID,
          accountKey: `icp.design:company:${COMPANY_ID}:${REQUEST_SHA256}`,
        });
        expect(wsOpened.authorizedCapMicrousd).toBe(BYPASS_TECHNICAL_CAP_MICROUSD);
        const wsRes = await store.reserve({
          workspaceId: WORKSPACE_ID,
          accountKey: `icp.design:company:${COMPANY_ID}:${REQUEST_SHA256}`,
          operationKey: 'ws-op-1',
          estimatedMicrousd: 50n,
        });
        await store.settle(wsRes, 50n);
        expect(
          await store.status({
            workspaceId: WORKSPACE_ID,
            accountKey: `icp.design:company:${COMPANY_ID}:${REQUEST_SHA256}`,
          }),
        ).toEqual({
          remainingMicrousd: BYPASS_TECHNICAL_CAP_MICROUSD,
          exhausted: false,
          open: true,
        });
        await store.close({
          workspaceId: WORKSPACE_ID,
          accountKey: `icp.design:company:${COMPANY_ID}:${REQUEST_SHA256}`,
        });
        expect(openSpy).not.toHaveBeenCalled();
        expect(reserveSpy).not.toHaveBeenCalled();
        expect(settleSpy).not.toHaveBeenCalled();
        expect(statusSpy).not.toHaveBeenCalled();
        expect(closeSpy).not.toHaveBeenCalled();

        // 2) Platform scope -> delegated to PostgresBudgetStore across all lifecycle methods.
        const platOpened = await store.open({
          authorityId: AUTHORITY_ID,
          scopeKey: 'platform',
          accountKey: 'platform:sanctions',
        });
        expect(platOpened.accountId).toBe('plat-acct-1');
        expect(openSpy).toHaveBeenCalledTimes(1);

        const platAttested = await store.attestAuthorized({
          authorityId: AUTHORITY_ID,
          scopeKey: 'platform',
          accountKey: 'platform:sanctions',
        });
        expect(platAttested.accountId).toBe('plat-acct-1');
        expect(attestSpy).toHaveBeenCalledTimes(1);

        const platRes = await store.reserve({
          workspaceId: 'platform',
          accountKey: 'platform:sanctions',
          operationKey: 'plat-op-1',
          estimatedMicrousd: 100n,
        });
        expect(platRes.operationId).toBe('plat-op-1');
        expect(reserveSpy).toHaveBeenCalledTimes(1);

        await store.settle(platRes, 80n);
        expect(settleSpy).toHaveBeenCalledTimes(1);

        await store.release(platRes);
        expect(releaseSpy).toHaveBeenCalledTimes(1);

        expect(
          await store.status({
            workspaceId: 'platform',
            accountKey: 'platform:sanctions',
          }),
        ).toMatchObject({ remainingMicrousd: 499_920n });
        expect(statusSpy).toHaveBeenCalledTimes(1);

        await store.close({
          workspaceId: 'platform',
          accountKey: 'platform:sanctions',
        });
        expect(closeSpy).toHaveBeenCalledTimes(1);
      } finally {
        openSpy.mockRestore();
        attestSpy.mockRestore();
        reserveSpy.mockRestore();
        settleSpy.mockRestore();
        statusSpy.mockRestore();
        closeSpy.mockRestore();
        releaseSpy.mockRestore();
      }
    });

    it('buildToolBroker in bypass mode routes platform calls to PostgresBudgetStore instead of throwing SCOPE_MISMATCH', async () => {
      vi.stubEnv(LEGACY_EXECUTION_BUDGET_MODE_ENV, 'bypass');
      const reserveSpy = vi
        .spyOn(PostgresBudgetStore.prototype, 'reserve')
        .mockRejectedValue(new BudgetStoreUnavailableError('platform_db_reached'));
      try {
        const fakePrisma = {
          sourceComplianceMatrix: { findUnique: vi.fn(async () => null) },
        } as unknown as PrismaService;
        const broker = buildToolBroker({
          prisma: fakePrisma,
          limiter: new RateLimiter(),
        });
        await expect(
          broker.invoke(
            'searxng.search',
            { query: 'valves' },
            {
              workspaceId: 'platform',
              runId: 'plat-run-1',
              platformEgress: {
                authorizeAndDispatch: async (_op, run) => run(),
              },
            },
          ),
        ).rejects.toThrow(BudgetStoreUnavailableError);
        expect(reserveSpy).toHaveBeenCalledTimes(1);
      } finally {
        reserveSpy.mockRestore();
      }
    });

    it('rejects platform scope in StatelessTechnicalBudgetStore status/close/release as well', async () => {
      const store = new StatelessTechnicalBudgetStore();
      await expect(
        store.status({ workspaceId: 'platform', accountKey: 'platform:schedule' }),
      ).rejects.toMatchObject({ code: 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH' });
      await expect(
        store.close({ workspaceId: 'platform', accountKey: 'platform:schedule' }),
      ).rejects.toMatchObject({ code: 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH' });
      await expect(
        store.release({
          workspaceId: 'platform',
          accountKey: 'platform:schedule',
          operationId: 'op-1',
          estimatedMicrousd: 10n,
          replay: false,
        }),
      ).rejects.toMatchObject({ code: 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH' });
    });

    it('delegates markResultUnknown, loadResultUnknownArtifact, settleArtifactManifest, and readOperationResult by scope', async () => {
      const platformStore: BudgetStore = {
        open: vi.fn(),
        attestAuthorized: vi.fn(),
        reserve: vi.fn(),
        settle: vi.fn(),
        markResultUnknown: vi.fn(async () => ({ reservedMicrousd: 100n, replay: false })),
        loadResultUnknownArtifact: vi.fn(async () => null),
        settleArtifactManifest: vi.fn(async () => ({
          chargedMicrousd: 100n,
          observedMicrousd: 100n,
          capVariance: false,
          replay: false,
        })),
        release: vi.fn(),
        status: vi.fn(),
        close: vi.fn(),
        readOperationResult: vi.fn(async () => ({ status: 'NOT_FOUND' as const })),
      };
      const store = new ScopeRoutedBypassBudgetStore(platformStore);
      const platRes = {
        workspaceId: 'platform',
        accountKey: 'platform:sanctions',
        operationId: 'op-plat',
        estimatedMicrousd: 100n,
        replay: false,
      };
      await store.markResultUnknown(platRes);
      await store.loadResultUnknownArtifact(platRes, AUTHORITY_ID);
      await store.settleArtifactManifest(platRes, 100n, {} as never, {} as never, {} as never);
      await store.readOperationResult({
        scopeKey: 'platform',
        authorityId: AUTHORITY_ID,
        accountKey: 'platform:sanctions',
        accountGeneration: 1,
        operationKey: 'op-plat',
        resultSchema: 'source-gleif/v1' as never,
      });
      expect(platformStore.markResultUnknown).toHaveBeenCalledTimes(1);
      expect(platformStore.loadResultUnknownArtifact).toHaveBeenCalledTimes(1);
      expect(platformStore.settleArtifactManifest).toHaveBeenCalledTimes(1);
      expect(platformStore.readOperationResult).toHaveBeenCalledTimes(1);
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

    it('still enforces G3 PERSONAL_DATA subject binding and GDPR DSR tombstone/suppression gate in bypass mode before wire', async () => {
      const executeSpy = vi.fn(async () => ({
        data: { url: 'https://example.com/', text: 'hello', contentHash: 'a'.repeat(24) },
        costCents: 0,
      }));
      const personalDataTool: Tool = {
        ...sampleTool('crawl4ai.fetch', 'none'),
        compliance: {
          sourcePolicy: 'none',
          respectsRobots: true,
          personalData: true,
          allowedPurpose: ['discovery'],
          reversible: true,
          authRequired: false,
          risk: 'medium',
        },
        durableResultStrategy: {
          kind: 'artifact_reference',
          schema: 'crawl4ai-fetch/v1',
          privacyClass: 'PERSONAL_DATA',
          mediaTypes: ['text/markdown'],
          maxBytes: 300_000,
          ttlSeconds: 86_400,
        },
        execute: executeSpy,
      };
      const registry = new ToolRegistry();
      registry.register(personalDataTool);
      const admit = vi.fn();
      const persist = vi.fn();
      const replay = vi.fn();
      const artifactExecution: ArtifactExecutionPort = { admit, persist, replay };
      const budgetStore = new UnavailableBudgetStore('must not be called in bypass');
      const releaseSpy = vi.spyOn(budgetStore, 'release');
      const broker = new ToolBroker({
        registry,
        budgetStore,
        limiter: new RateLimiter(),
        artifactExecution,
        legacyBudgetMode: 'bypass',
      });

      // 1) Missing artifactSubject -> denied before wire.
      await expect(
        broker.invoke(
          'crawl4ai.fetch',
          { url: 'https://example.com/' },
          { workspaceId: WORKSPACE_ID, runId: 'run-g3' },
        ),
      ).rejects.toMatchObject({
        name: 'ToolPolicyDenied',
        reason: 'GENERIC_OPERATION_ARTIFACT_SUBJECT_BINDING_HOLD',
      });
      expect(executeSpy).not.toHaveBeenCalled();
      expect(admit).not.toHaveBeenCalled();
      expect(releaseSpy).not.toHaveBeenCalled();

      // 2) DSR tombstone -> denied before tool.execute(), zero budgetStore.release().
      admit.mockResolvedValueOnce({ status: 'DENIED', reason: 'SUBJECT_TOMBSTONED' });
      await expect(
        broker.invoke(
          'crawl4ai.fetch',
          { url: 'https://example.com/' },
          {
            workspaceId: WORKSPACE_ID,
            runId: 'run-g3',
            artifactSubject: { subjectType: 'company', subjectId: COMPANY_ID },
          },
        ),
      ).rejects.toMatchObject({
        name: 'ToolPolicyDenied',
        reason: 'GENERIC_OPERATION_ARTIFACT_SUBJECT_TOMBSTONED',
      });
      expect(executeSpy).not.toHaveBeenCalled();
      expect(releaseSpy).not.toHaveBeenCalled();

      // 3) Subject SUPPRESSED -> denied before tool.execute().
      admit.mockResolvedValueOnce({ status: 'DENIED', reason: 'SUBJECT_SUPPRESSED' });
      await expect(
        broker.invoke(
          'crawl4ai.fetch',
          { url: 'https://example.com/' },
          {
            workspaceId: WORKSPACE_ID,
            runId: 'run-g3',
            artifactSubject: { subjectType: 'company', subjectId: COMPANY_ID },
          },
        ),
      ).rejects.toMatchObject({
        name: 'ToolPolicyDenied',
        reason: 'GENERIC_OPERATION_ARTIFACT_SUBJECT_SUPPRESSED',
      });
      expect(executeSpy).not.toHaveBeenCalled();

      // 4) BOUND subject -> executes tool and skips artifactExecution.persist() (zero ToolBudgetOperation DB writes).
      admit.mockResolvedValueOnce({
        status: 'BOUND',
        subjectRef: { subjectType: 'company', subjectId: COMPANY_ID },
      });
      const ok = await broker.invoke(
        'crawl4ai.fetch',
        { url: 'https://example.com/' },
        {
          workspaceId: WORKSPACE_ID,
          runId: 'run-g3',
          artifactSubject: { subjectType: 'company', subjectId: COMPANY_ID },
        },
      );
      expect(ok.data).toMatchObject({ url: 'https://example.com/' });
      expect(executeSpy).toHaveBeenCalledTimes(1);
      expect(persist).not.toHaveBeenCalled();
      expect(releaseSpy).not.toHaveBeenCalled();
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

  describe('contact enrichment (HTTP & Run) in bypass mode', () => {
    function makeBypassEnrichmentPrisma(options?: { enabled?: boolean; domain?: string | null }) {
      const tx = {
        canonicalCompany: {
          findUnique: vi.fn(async () =>
            options?.domain === null
              ? { id: COMPANY_ID, name: 'No Domain Co', domain: null }
              : { id: COMPANY_ID, name: 'Acme Valves', domain: 'acme.example.invalid' },
          ),
        },
        canonicalContact: {
          findMany: vi.fn(async () => []),
        },
        lead: {
          findFirst: vi.fn(async () => null),
        },
        $queryRaw: vi.fn(() => {
          throw new Error('bypass enrichment must not lock execution_budget_authority or tool_budget_account');
        }),
      };
      return {
        dataProvider: {
          findUnique: vi.fn(async () => ({
            status: options?.enabled === false ? 'DISABLED' : 'ENABLED',
            config: null,
          })),
        },
        sourcePolicy: {
          findUnique: vi.fn(async () => ({
            reviewStatus: 'APPROVED',
            allowedPurpose: ['enrichment'],
            retentionDays: 1,
            updatedAt: new Date('2026-11-26T00:00:00.000Z'),
          })),
        },
        withWorkspace: vi.fn(async (_ws: string, fn: (client: unknown) => Promise<unknown>) => fn(tx)),
      };
    }

    it('createManagedContactEnrichmentSafety returns bypass executor in bypass mode without requiring legacy DB locks or S3 artifact env', async () => {
      const prisma = makeBypassEnrichmentPrisma();
      const verifyWorkspaceGrant = vi.fn().mockRejectedValue(new Error('must not be called'));
      const consumeInTx = vi.fn().mockRejectedValue(new Error('must not be called'));
      const dummyBroker = {
        invoke: vi.fn(),
        checkSourcePolicy: vi.fn(async () => ({ allowed: true })),
      };
      const managed = await createManagedContactEnrichmentSafety({
        prisma: prisma as never,
        env: {
          [LEGACY_EXECUTION_BUDGET_MODE_ENV]: 'bypass',
          HUNTER_API_KEY: 'fake-hunter-key',
        } as NodeJS.ProcessEnv,
        budgetStore: new StatelessTechnicalBudgetStore(),
        authority: { verifyWorkspaceGrant },
        grantConsumer: { consumeVerifiedWorkspaceGrantInTransaction: consumeInTx },
        buildBroker: () => dummyBroker as never,
      });

      expect(managed.broker).toBe(dummyBroker);
      expect(managed.service).toBeDefined();
      expect(managed.unavailableReason).toBeUndefined();

      // Missing lawfulBasis still returns 403 before running waterfall.
      await expect(
        managed.service!.executeHttp(
          { userId: 'u-1', workspaceId: WORKSPACE_ID, roles: ['admin'] },
          COMPANY_ID,
          {},
        ),
      ).rejects.toMatchObject({
        response: { error: { code: 'CONTACT_ENRICH_LAWFUL_BASIS_REQUIRED' } },
      });

      // Valid HTTP request succeeds without CONTROL_MISMATCH (no contacts -> NOT_ADMITTED NO_CONTACTS).
      const httpNoContacts = await managed.service!.executeHttp(
        { userId: 'u-1', workspaceId: WORKSPACE_ID, roles: ['admin'] },
        COMPANY_ID,
        { lawfulBasis: { basis: 'legitimate_interest', ref: 'LIA-1' } },
      );
      expect(httpNoContacts).toMatchObject({
        companyId: COMPANY_ID,
        admission: 'NOT_ADMITTED',
        reasonCode: 'NO_CONTACTS',
        attempted: 0,
      });
      expect(verifyWorkspaceGrant).not.toHaveBeenCalled();
      expect(consumeInTx).not.toHaveBeenCalled();
    });

    it('executes HTTP and Run contact enrichment through direct waterfall in bypass mode without CONTROL_MISMATCH', async () => {
      const prisma = makeBypassEnrichmentPrisma();
      const runWaterfall = vi.fn(async () => ({
        companyId: COMPANY_ID,
        tier: 'B' as const,
        attempted: 2,
        costMicrousd: 3_400,
        deadlineHit: false,
        results: [{ contactId: '00000000-0000-4000-8000-000000000099', status: 'not_found' as const }],
      }));
      const dummyBroker = {
        invoke: vi.fn(),
        checkSourcePolicy: vi.fn(async () => ({ allowed: true })),
      };
      const executor = createBypassContactEnrichmentSafetyExecutor({
        prisma: prisma as never,
        env: {
          [LEGACY_EXECUTION_BUDGET_MODE_ENV]: 'bypass',
          HUNTER_API_KEY: 'fake-hunter-key',
        } as NodeJS.ProcessEnv,
        broker: dummyBroker as never,
        runWaterfall: runWaterfall as never,
      });

      // 1) HTTP execution -> ADMITTED, passes lawfulBasis/options/accountKey.
      const httpRes = await executor.executeHttp(
        { userId: 'user-1', workspaceId: WORKSPACE_ID, roles: ['admin'] },
        COMPANY_ID,
        {
          lawfulBasis: { basis: 'legitimate_interest', ref: 'LIA-99' },
          maxProviders: 2,
          maxProbe: 4,
          attemptId: 'att-1',
        },
      );
      expect(httpRes).toMatchObject({
        companyId: COMPANY_ID,
        admission: 'ADMITTED',
        attempted: 2,
        costMicrousd: 3_400,
        qualityCoverage: 'PREREQUISITE_ONLY',
      });
      expect(runWaterfall).toHaveBeenCalledWith(
        expect.objectContaining({ verificationBroker: dummyBroker, actorId: 'user-1' }),
        expect.objectContaining({
          workspaceId: WORKSPACE_ID,
          companyId: COMPANY_ID,
          maxProvidersPerContact: 2,
          maxVerificationCalls: 4,
        }),
      );

      // 2) Run execution via executeContactEnrichmentSafetyActivity with synthetic bypass binding.
      const runId = '77777777-7777-4777-8777-777777777777';
      const binding = {
        authorityId: AUTHORITY_ID,
        replay: false,
        scopeKey: WORKSPACE_ID,
        accountKey: `discovery.run:discovery_run:request:${REQUEST_SHA256}:${REQUEST_SHA256}`,
        purpose: 'discovery.run' as const,
        subjectType: 'discovery_run',
        subjectId: `request:${REQUEST_SHA256}`,
        requestSha256: REQUEST_SHA256,
      };
      const activityRes = await executeContactEnrichmentSafetyActivity(executor, {
        workspaceId: WORKSPACE_ID,
        companyId: COMPANY_ID,
        runId,
        binding,
        lawfulBasis: { basis: 'legitimate_interest' },
        remainingMicrousd: BYPASS_TECHNICAL_CAP_MICROUSD,
      });
      expect(activityRes).toEqual({
        skipped: false,
        tier: 'B',
        attempted: 2,
        costMicrousd: 3_400,
      });

      // 3) No configured finder returns NOT_ADMITTED honestly.
      const noFinderExecutor = createBypassContactEnrichmentSafetyExecutor({
        prisma: prisma as never,
        env: { [LEGACY_EXECUTION_BUDGET_MODE_ENV]: 'bypass' } as NodeJS.ProcessEnv,
        broker: dummyBroker as never,
        runWaterfall: runWaterfall as never,
      });
      const notAdmitted = await noFinderExecutor.executeHttp(
        { userId: 'user-1', workspaceId: WORKSPACE_ID, roles: ['admin'] },
        COMPANY_ID,
        { lawfulBasis: { basis: 'legitimate_interest' } },
      );
      expect(notAdmitted).toMatchObject({
        admission: 'NOT_ADMITTED',
        reasonCode: 'NO_CONFIGURED_FINDER',
        attempted: 0,
      });
    });
  });
});
