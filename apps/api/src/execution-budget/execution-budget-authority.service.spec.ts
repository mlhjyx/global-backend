import 'reflect-metadata';
import { readFile } from 'node:fs/promises';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../auth/request-context';
import { AppModule } from '../app.module';
import { ModelGatewayModule } from '../model-gateway/model-gateway.module';
import { ExecutionBudgetAuthorityReadinessContributors } from '../runtime/managed-dependency-readiness';
import { TOOL_BUDGET_STORE } from '../tools/budget-store';
import { ExecutionBudgetAuthorityRepository } from './execution-budget-authority.repository';
import {
  ExecutionBudgetAuthorityService,
  type WorkspaceExecutionBudgetGrantInput,
} from './execution-budget-authority.service';
import {
  ExecutionBudgetGrantError,
  type VerifiedExecutionBudgetAuthority,
} from './execution-budget-authority.types';
import { ExecutionBudgetGrantVerifier } from './execution-budget-grant.verifier';
import { ExecutionBudgetModule } from './execution-budget.module';

const WORKSPACE_ID = 'e03abddd-1307-47cb-a731-7e7a786615a0';
const AUTHORITY_ID = '42c863b9-7c7e-4d28-8678-60ef9a20219b';
const COMPANY_ID = 'f5ba98f2-a0e2-4e85-b799-e85568877702';
const REQUEST_SHA256 = 'a'.repeat(64);
const TOKEN_SHA256 = 'b'.repeat(64);
const COMPACT_JWS = 'private.header.payload.signature';
const ACCOUNT_KEY = `icp.design:company:${COMPANY_ID}:${REQUEST_SHA256}`;

const identity: Pick<RequestContext, 'workspaceId'> = Object.freeze({
  workspaceId: WORKSPACE_ID,
});
const scope = Object.freeze({
  purpose: 'icp.design' as const,
  subjectType: 'company',
  subjectId: COMPANY_ID,
  requestSha256: REQUEST_SHA256,
});

function verifiedAuthority(): VerifiedExecutionBudgetAuthority {
  return Object.freeze({
    schemaVersion: 'execution-budget-grant/v1',
    authorityKind: 'WORKSPACE_GRANT',
    issuer: 'https://control.example.test/',
    audience: 'global-backend:execution-budget',
    jti: '120a4e9f-0c06-4cb4-8364-b7df51c45a88',
    purpose: scope.purpose,
    workspaceId: WORKSPACE_ID,
    subjectType: scope.subjectType,
    subjectId: scope.subjectId,
    requestSha256: scope.requestSha256,
    scheduleId: null,
    currency: 'USD',
    unit: 'microusd',
    capMicrousd: 2_000_000n,
    capPerRunMicrousd: null,
    campaignCapMicrousd: null,
    maxRuns: null,
    tokenSha256: TOKEN_SHA256,
    issuedAt: 1_787_270_400,
    notBefore: 1_787_270_401,
    expiresAt: 1_787_270_640,
  });
}

function input(compactJws = COMPACT_JWS): WorkspaceExecutionBudgetGrantInput {
  return Object.freeze({ compactJws, identity, scope });
}

function serviceHarness(options?: {
  readonly verifyFailure?: Error;
  readonly consumeFailure?: Error;
  readonly replay?: boolean;
  readonly includeUnexpectedRawToken?: boolean;
  readonly subjectId?: string;
}) {
  const baseAuthority = {
    ...verifiedAuthority(),
    subjectId: options?.subjectId ?? COMPANY_ID,
  };
  const authority = options?.includeUnexpectedRawToken
    ? { ...baseAuthority, compactJws: COMPACT_JWS }
    : baseAuthority;
  const verify = options?.verifyFailure
    ? vi.fn().mockRejectedValue(options.verifyFailure)
    : vi.fn().mockResolvedValue(authority);
  const consumeWorkspaceAndOpen = options?.consumeFailure
    ? vi.fn().mockRejectedValue(options.consumeFailure)
    : vi.fn().mockResolvedValue({
        authorityId: AUTHORITY_ID,
        replay: options?.replay ?? false,
        accountId: '8cf66f2a-1780-453e-8d7d-f70e36cb22a6',
        generation: 1,
        authorizedCapMicrousd: 2_000_000n,
      });
  const service = new ExecutionBudgetAuthorityService(
    { verify } as unknown as ExecutionBudgetGrantVerifier,
    {
      consumeWorkspaceAndOpen,
    } as unknown as ExecutionBudgetAuthorityRepository,
  );
  return { service, verify, consumeWorkspaceAndOpen };
}

describe('ExecutionBudgetAuthorityService', () => {
  it.each([
    'EXECUTION_BUDGET_GRANT_REQUIRED',
    'EXECUTION_BUDGET_GRANT_INVALID',
    'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH',
  ] as const)(
    'verifies before persistence and performs zero writes for %s',
    async (code) => {
      const failure = new ExecutionBudgetGrantError(code);
      const { service, verify, consumeWorkspaceAndOpen } = serviceHarness({
        verifyFailure: failure,
      });

      await expect(
        service.consumeWorkspaceGrant(input('invalid')),
      ).rejects.toBe(failure);

      expect(verify).toHaveBeenCalledWith('invalid', {
        authorityKind: 'WORKSPACE_GRANT',
        workspaceId: WORKSPACE_ID,
        ...scope,
      });
      expect(consumeWorkspaceAndOpen).not.toHaveBeenCalled();
    },
  );

  it('verifies without consuming when only a workspace grant check is requested', async () => {
    const { service, consumeWorkspaceAndOpen } = serviceHarness();

    await expect(service.verifyWorkspaceGrant(input())).resolves.toMatchObject({
      tokenSha256: TOKEN_SHA256,
      requestSha256: REQUEST_SHA256,
    });
    expect(consumeWorkspaceAndOpen).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'returns one stable immutable binding when repository replay is %s',
    async (replay) => {
      const { service, consumeWorkspaceAndOpen } = serviceHarness({ replay });

      const binding = await service.consumeWorkspaceGrant(input());

      expect(binding).toEqual({
        authorityId: AUTHORITY_ID,
        replay,
        scopeKey: WORKSPACE_ID,
        accountKey: ACCOUNT_KEY,
        purpose: 'icp.design',
        subjectType: 'company',
        subjectId: COMPANY_ID,
      });
      expect(Object.isFrozen(binding)).toBe(true);
      expect(consumeWorkspaceAndOpen).toHaveBeenCalledWith(
        expect.objectContaining({
          tokenSha256: TOKEN_SHA256,
          requestSha256: REQUEST_SHA256,
        }),
        ACCOUNT_KEY,
      );
    },
  );

  it('reduces verifier output to the exact verified claim shape so raw JWS never enters persistence', async () => {
    const { service, consumeWorkspaceAndOpen } = serviceHarness({
      includeUnexpectedRawToken: true,
    });

    await service.consumeWorkspaceGrant(input());

    const [authority] = consumeWorkspaceAndOpen.mock.calls[0] ?? [];
    expect(
      JSON.stringify(authority, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ).not.toContain(COMPACT_JWS);
    expect(authority).not.toHaveProperty('compactJws');
    expect(authority).toMatchObject({ tokenSha256: TOKEN_SHA256 });
  });

  it('preserves repository replay in the immutable binding for endpoint admission', async () => {
    const { service } = serviceHarness({ replay: true });

    await expect(service.consumeWorkspaceGrant(input())).resolves.toMatchObject({
      authorityId: AUTHORITY_ID,
      replay: true,
    });
  });

  it('does not echo a raw JWS when atomic persistence rejects', async () => {
    const failure = new ExecutionBudgetGrantError(
      'EXECUTION_BUDGET_AUTHORITY_REVOKED',
    );
    const { service } = serviceHarness({ consumeFailure: failure });

    const caught = await service
      .consumeWorkspaceGrant(input())
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(caught).toBe(failure);
    expect(String(caught)).not.toContain(COMPACT_JWS);
  });

  it('rejects an overlong deterministic account key before repository persistence', async () => {
    const longSubject = 's'.repeat(191);
    const { service, consumeWorkspaceAndOpen } = serviceHarness({
      subjectId: longSubject,
    });

    await expect(
      service.consumeWorkspaceGrant({
        ...input(),
        scope: { ...scope, subjectId: longSubject },
      }),
    ).rejects.toMatchObject({ code: 'EXECUTION_BUDGET_GRANT_INVALID' });
    expect(consumeWorkspaceAndOpen).not.toHaveBeenCalled();
  });
});

describe('ExecutionBudgetModule product composition', () => {
  it('registers and exports the authority application services without a transport', async () => {
    const { PlatformExecutionBudgetAuthorityIngestionService } =
      await import('./platform-authority-ingestion.service');
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      ExecutionBudgetModule,
    ) as readonly unknown[];
    const exports = Reflect.getMetadata(
      MODULE_METADATA.EXPORTS,
      ExecutionBudgetModule,
    ) as readonly unknown[];

    expect(providers).toEqual([
      {
        provide: ExecutionBudgetGrantVerifier,
        useFactory: expect.any(Function),
      },
      ExecutionBudgetAuthorityRepository,
      ExecutionBudgetAuthorityService,
      PlatformExecutionBudgetAuthorityIngestionService,
      ExecutionBudgetAuthorityReadinessContributors,
    ]);
    expect(exports).toEqual([
      ExecutionBudgetAuthorityService,
      PlatformExecutionBudgetAuthorityIngestionService,
    ]);
    expect(providers).not.toContain(TOOL_BUDGET_STORE);
    const verifierProvider = providers[0] as {
      useFactory: () => ExecutionBudgetGrantVerifier;
    };
    expect(verifierProvider.useFactory()).toBeInstanceOf(
      ExecutionBudgetGrantVerifier,
    );
  });

  it('does not add a second BudgetStore provider to ModelGatewayModule', () => {
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      AppModule,
    ) as readonly unknown[];
    const gatewayProviders = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      ModelGatewayModule,
    ) as readonly unknown[];

    expect(imports).toContain(ExecutionBudgetModule);
    expect(imports).toContain(ModelGatewayModule);
    expect(
      gatewayProviders.filter(
        (provider) =>
          typeof provider === 'object' &&
          provider !== null &&
          'provide' in provider &&
          provider.provide === TOOL_BUDGET_STORE,
      ),
    ).toHaveLength(1);
  });

  it('contains no raw grant, signer, fixture key, fallback or second BudgetStore transaction', async () => {
    const [moduleSource, serviceSource] = await Promise.all([
      readFile(
        new URL('./execution-budget.module.ts', import.meta.url),
        'utf8',
      ),
      readFile(
        new URL('./execution-budget-authority.service.ts', import.meta.url),
        'utf8',
      ),
    ]);

    expect(moduleSource).not.toContain(COMPACT_JWS);
    expect(moduleSource).not.toMatch(/sign|private|fixture|fallback/i);
    expect(moduleSource).not.toContain('TOOL_BUDGET_STORE');
    expect(serviceSource).not.toContain('TOOL_BUDGET_STORE');
    expect(serviceSource).not.toContain('openAuthorized');
  });
});
