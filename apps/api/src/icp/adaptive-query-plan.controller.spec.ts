import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { ScopesGuard } from '../auth/scopes.guard';
import { AdaptiveQueryPlanController } from './adaptive-query-plan.controller';

type ApiResponseMetadata = Record<string, { schema?: Record<string, unknown> }>;

function executionContext(request: object): ExecutionContext {
  return {
    getHandler: () => AdaptiveQueryPlanController.prototype.suggest,
    getClass: () => AdaptiveQueryPlanController,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('AdaptiveQueryPlanController', () => {
  it('requires acquisition:write', () => {
    const guard = new ScopesGuard(new Reflector());
    let caught: unknown;
    try {
      guard.canActivate(executionContext({ requestContext: { scopes: ['acquisition:read'] } }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ForbiddenException);
    expect(caught).toMatchObject({ status: 403, response: { error: { code: 'SCOPE_REQUIRED' } } });
  });

  it('documents success, validation, scope, tenant-hidden and state-conflict responses', () => {
    const metadata = Reflect.getMetadata(
      'swagger/apiResponse',
      AdaptiveQueryPlanController.prototype.suggest,
    ) as ApiResponseMetadata;
    expect(Object.keys(metadata).sort()).toEqual(['200', '400', '403', '404', '409']);
  });

  it('delegates to the isolated service and envelopes its result', async () => {
    const result = {
      outcome: 'CONVERGED' as const,
      replayed: false,
      convergenceReason: 'MAX_ROUNDS_REACHED' as const,
      plan: null,
    };
    const service = { suggestForCompletedRun: vi.fn(async () => result) };
    const controller = new AdaptiveQueryPlanController(service as never);
    const ctx = {
      userId: '11111111-1111-4111-8111-111111111111',
      workspaceId: '22222222-2222-4222-8222-222222222222',
      roles: [],
      scopes: ['acquisition:write'] as const,
    };

    await expect(controller.suggest(ctx, '33333333-3333-4333-8333-333333333333', {
      maxRounds: 3,
    })).resolves.toEqual({ data: result });
    expect(service.suggestForCompletedRun).toHaveBeenCalledWith(
      ctx,
      '33333333-3333-4333-8333-333333333333',
      { currentRound: undefined, maxRounds: 3 },
    );
  });

  it('exports the DRAFT suggestion route and its closed scope to OpenAPI', () => {
    const document = JSON.parse(readFileSync(
      resolve(process.cwd(), '../../packages/contracts/openapi/openapi.json'),
      'utf8',
    )) as {
      paths: Record<string, Record<string, {
        'x-required-scopes'?: string[];
        responses?: Record<string, unknown>;
      }>>;
    };
    const operation = document.paths[
      '/api/v1/discovery-runs/{runId}/adaptive-query-plan-suggestions'
    ]?.post;

    expect(operation?.['x-required-scopes']).toEqual(['acquisition:write']);
    expect(Object.keys(operation?.responses ?? {}).sort()).toEqual(['200', '400', '403', '404', '409']);
    const schema = document as unknown as {
      components: { schemas: { CreateAdaptiveQueryPlanSuggestionDto: { required?: string[] } } };
    };
    expect(schema.components.schemas.CreateAdaptiveQueryPlanSuggestionDto.required ?? []).not.toContain('currentRound');
  });
});
