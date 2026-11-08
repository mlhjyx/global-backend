import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BadRequestException,
  ServiceUnavailableException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { ExecutionBudgetGrantError } from '../execution-budget/execution-budget-authority.types';
import { CampaignPlanServiceTokenGuard } from './campaign-plan-service-token.guard';
import {
  CampaignPlanInternalController,
  parseCampaignPlanDraftBody,
} from './campaign-plan-internal.controller';

/**
 * M2.1 服务间入口：服务令牌 fail-closed（缺配置 503 / 缺 token 401 / 不匹配 401）、
 * 请求闭合校验、Grant 校验先于任何副作用、以及 launch 只带 vetted 输入。
 */

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const CAMPAIGN_ID = '22222222-2222-4222-8222-222222222222';
const JOB_ID = '33333333-3333-4333-8333-333333333333';
const AUTHORITY_ID = '44444444-4444-4444-8444-444444444444';

function context(headers: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
    }),
  } as unknown as ExecutionContext;
}

const TOKEN_ENV = 'CAMPAIGN_PLAN_INTERNAL_SERVICE_TOKEN';
beforeEach(() => {
  delete process.env[TOKEN_ENV];
});

describe('CampaignPlanServiceTokenGuard', () => {
  it('fails closed with 503 when the service token is not configured', () => {
    const guard = new CampaignPlanServiceTokenGuard();
    expect(() => guard.canActivate(context({ 'x-service-token': 'x' }))).toThrow(
      ServiceUnavailableException,
    );
  });

  it('rejects a missing or mismatched token with 401', () => {
    process.env[TOKEN_ENV] = 'expected-token-value';
    const guard = new CampaignPlanServiceTokenGuard();
    expect(() => guard.canActivate(context({}))).toThrow(UnauthorizedException);
    expect(() =>
      guard.canActivate(context({ 'x-service-token': 'wrong-token-value' })),
    ).toThrow(UnauthorizedException);
    expect(() =>
      guard.canActivate(context({ 'x-service-token': 'expected-token-value' })),
    ).not.toThrow();
  });
});

describe('parseCampaignPlanDraftBody', () => {
  const valid = {
    workspaceId: WORKSPACE_ID,
    campaignId: CAMPAIGN_ID,
    jobId: JOB_ID,
    objective: '在德国找 30 家泵类分销商',
  };

  it('accepts the closed minimum and optional bounds', () => {
    expect(parseCampaignPlanDraftBody(valid)).toEqual(valid);
    expect(
      parseCampaignPlanDraftBody({
        ...valid,
        audienceSizeCap: 1000,
        budgetCapMicros: 0,
      }),
    ).toMatchObject({ audienceSizeCap: 1000, budgetCapMicros: 0 });
  });

  it.each([
    ['unknown key', { ...valid, extra: 1 }],
    ['bad uuid', { ...valid, campaignId: 'nope' }],
    ['empty objective', { ...valid, objective: '   ' }],
    ['control chars', { ...valid, objective: 'a\u0000b' }],
    ['sizeCap 0', { ...valid, audienceSizeCap: 0 }],
    ['sizeCap 1001', { ...valid, audienceSizeCap: 1001 }],
    ['negative budget', { ...valid, budgetCapMicros: -1 }],
  ])('rejects %s with CAMPAIGN_PLAN_REQUEST_INVALID', (_name, body) => {
    expect(() => parseCampaignPlanDraftBody(body)).toThrow(BadRequestException);
  });
});

describe('CampaignPlanInternalController.requestDraft', () => {
  const body = {
    workspaceId: WORKSPACE_ID,
    campaignId: CAMPAIGN_ID,
    jobId: JOB_ID,
    objective: '在德国找 30 家泵类分销商',
  };

  it('verifies then consumes the grant and launches with the exact binding', async () => {
    const binding = {
      authorityId: AUTHORITY_ID,
      replay: false,
      scopeKey: WORKSPACE_ID,
      accountKey: 'workspace-account',
      purpose: 'campaign.plan' as const,
      subjectType: 'campaign',
      subjectId: CAMPAIGN_ID,
      requestSha256: 'a'.repeat(64),
    };
    const authority = {
      verifyWorkspaceGrant: vi.fn().mockResolvedValue({ verified: true }),
      consumeVerifiedWorkspaceGrant: vi.fn().mockResolvedValue(binding),
    };
    const launcher = { launch: vi.fn().mockResolvedValue(undefined) };
    const controller = new CampaignPlanInternalController(
      authority as never,
      launcher as never,
    );

    const response = await controller.requestDraft(body, 'compact.jws.token');

    expect(authority.verifyWorkspaceGrant).toHaveBeenCalledWith({
      compactJws: 'compact.jws.token',
      identity: { workspaceId: WORKSPACE_ID },
      scope: {
        purpose: 'campaign.plan',
        subjectType: 'campaign',
        subjectId: CAMPAIGN_ID,
        requestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    expect(launcher.launch).toHaveBeenCalledWith({
      ...body,
      maxReplans: 0,
      executionBudget: binding,
    });
    expect(response).toEqual({ data: { jobId: JOB_ID } });
  });

  it('maps a missing grant to the stable execution-budget HTTP error before launch', async () => {
    const authority = {
      verifyWorkspaceGrant: vi
        .fn()
        .mockRejectedValue(new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_REQUIRED')),
      consumeVerifiedWorkspaceGrant: vi.fn(),
    };
    const launcher = { launch: vi.fn() };
    const controller = new CampaignPlanInternalController(
      authority as never,
      launcher as never,
    );

    await expect(controller.requestDraft(body, undefined)).rejects.toMatchObject({
      response: {
        error: { code: 'EXECUTION_BUDGET_GRANT_REQUIRED' },
      },
    });
    expect(launcher.launch).not.toHaveBeenCalled();
  });

  it('does not launch when the grant cannot be consumed (reuse)', async () => {
    const authority = {
      verifyWorkspaceGrant: vi.fn().mockResolvedValue({ verified: true }),
      consumeVerifiedWorkspaceGrant: vi
        .fn()
        .mockRejectedValue(new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_REUSED')),
    };
    const launcher = { launch: vi.fn() };
    const controller = new CampaignPlanInternalController(
      authority as never,
      launcher as never,
    );

    await expect(controller.requestDraft(body, 'token')).rejects.toMatchObject({
      response: { error: { code: 'EXECUTION_BUDGET_GRANT_REUSED' } },
    });
    expect(launcher.launch).not.toHaveBeenCalled();
  });
});
