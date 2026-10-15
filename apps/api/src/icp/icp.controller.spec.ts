import { ConflictException, HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../auth/request-context';
import { ExecutionBudgetGrantError } from '../execution-budget/execution-budget-authority.types';
import {
  ProviderOutputError,
  ProviderTransportError,
} from '../model-gateway/providers/provider-output-error';
import { IcpController } from './icp.controller';
import type { IcpService } from './icp.service';

/**
 * The two AI generation endpoints: a model answer the gateway settled as
 * unusable becomes 502 MODEL_UPSTREAM_UNUSABLE with the gateway reason code,
 * never a bare 500 (xin 2026-10-13, seller #24: CHAT_COMPLETIONS_CONTENT_FILTERED
 * after 284 s). Grant and business errors keep their own status and code.
 */

const CTX: RequestContext = { userId: 'u1', workspaceId: 'ws1', roles: ['admin'] };
const ICP_ID = '971c9242-0000-4000-8000-000000000001';
const COMPANY_ID = '20000000-0000-4000-8000-000000000024';
const GRANT = 'grant';
/** @nestjs/swagger DECORATORS.API_RESPONSE; the constants module is not exported. */
const SWAGGER_API_RESPONSE_METADATA = 'swagger/apiResponse';

const ICP_ROW = {
  id: ICP_ID,
  companyId: COMPANY_ID,
  name: 'Generated',
  status: 'HYPOTHESIS',
  companyAttributes: {},
  painPoints: [],
  triggerSignals: [],
  exclusions: [],
  valueProps: [],
  targetMarkets: [],
  version: 1,
  personas: [],
  roles: [],
  rules: [],
  createdAt: new Date('2026-10-13T08:00:00Z'),
};
const PLAN_ROW = {
  id: 'plan-1',
  icpId: ICP_ID,
  status: 'DRAFT',
  queries: [],
  estimatedVolume: 10,
  version: 1,
  createdAt: new Date('2026-10-13T08:00:00Z'),
};

function controllerWith(service: Partial<Record<keyof IcpService, unknown>>): IcpController {
  return new IcpController(service as unknown as IcpService);
}

async function rejectionOf(operation: Promise<unknown>): Promise<unknown> {
  return operation.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe.each([
  {
    endpoint: 'POST /icps/:icpId/query-plans',
    method: 'generateQueryPlan' as const,
    call: (controller: IcpController) => controller.generateQueryPlan(CTX, ICP_ID, GRANT),
    expectedArgs: [CTX, ICP_ID, GRANT],
    row: PLAN_ROW,
    data: { id: 'plan-1', icpId: ICP_ID, status: 'DRAFT' },
  },
  {
    endpoint: 'POST /companies/:companyId/icps',
    method: 'generateFromCompany' as const,
    call: (controller: IcpController) => controller.generate(CTX, COMPANY_ID, GRANT),
    expectedArgs: [CTX, COMPANY_ID, GRANT],
    row: ICP_ROW,
    data: { id: ICP_ID, companyId: COMPANY_ID, status: 'HYPOTHESIS' },
  },
])('$endpoint', ({ method, call, expectedArgs, row, data }) => {
  it('envelopes the generated row and forwards the grant untouched', async () => {
    const generate = vi.fn().mockResolvedValue(row);

    const response = await call(controllerWith({ [method]: generate }));

    expect(generate).toHaveBeenCalledWith(...expectedArgs);
    expect(response).toMatchObject({ data });
  });

  it.each([
    ['an unusable answer', new ProviderOutputError('CHAT_COMPLETIONS_CONTENT_FILTERED'), 'CHAT_COMPLETIONS_CONTENT_FILTERED'],
    ['a cut stream', new ProviderTransportError('CHAT_COMPLETIONS_STREAM_TRUNCATED'), 'CHAT_COMPLETIONS_STREAM_TRUNCATED'],
    [
      'an upstream error event',
      new ProviderTransportError('CHAT_COMPLETIONS_STREAM_UPSTREAM_ERROR'),
      'CHAT_COMPLETIONS_STREAM_UPSTREAM_ERROR',
    ],
  ])('answers 502 MODEL_UPSTREAM_UNUSABLE with the reason code for %s', async (_case, failure, reasonCode) => {
    const controller = controllerWith({ [method]: vi.fn().mockRejectedValue(failure) });

    const rejection = await rejectionOf(call(controller));

    expect(rejection).toBeInstanceOf(HttpException);
    expect((rejection as HttpException).getStatus()).toBe(502);
    expect((rejection as HttpException).getResponse()).toEqual({
      error: {
        code: 'MODEL_UPSTREAM_UNUSABLE',
        message: expect.any(String),
        details: { reasonCode },
      },
    });
  });

  it('keeps a reused grant at 409 EXECUTION_BUDGET_GRANT_REUSED', async () => {
    const controller = controllerWith({
      [method]: vi.fn().mockRejectedValue(new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_REUSED')),
    });

    const rejection = await rejectionOf(call(controller));

    expect(rejection).toBeInstanceOf(HttpException);
    expect((rejection as HttpException).getStatus()).toBe(409);
    expect((rejection as HttpException).getResponse()).toEqual({
      error: { code: 'EXECUTION_BUDGET_GRANT_REUSED', message: 'EXECUTION_BUDGET_GRANT_REUSED' },
    });
  });

  it('keeps a business conflict as the service raised it', async () => {
    const conflict = new ConflictException({ error: { code: 'NO_RUNNABLE_QUERIES', message: 'none' } });
    const controller = controllerWith({ [method]: vi.fn().mockRejectedValue(conflict) });

    await expect(call(controller)).rejects.toBe(conflict);
  });

  it('documents the 502 response in the code-first OpenAPI', () => {
    const handler = method === 'generateQueryPlan' ? 'generateQueryPlan' : 'generate';
    const responses = Reflect.getMetadata(
      SWAGGER_API_RESPONSE_METADATA,
      IcpController.prototype[handler],
    ) as Record<string, { description?: string }>;

    expect(responses['502']?.description).toContain('MODEL_UPSTREAM_UNUSABLE');
  });
});
