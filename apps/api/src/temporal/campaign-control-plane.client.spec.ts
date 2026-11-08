import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CampaignControlPlaneError,
  createHttpCampaignControlPlane,
} from './campaign-control-plane.client';

/**
 * 引擎 → gain-saas 内部回调客户端：HTTP 状态 → 失败分类（可重试 vs 终态），
 * 以及 CAMPAIGN_PLAN_INVALID 的 issues 提取（gain-saas 形态 `error.details.issues`）。
 */

const JOB = '33333333-3333-4333-8333-333333333333';
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const CAMPAIGN = '22222222-2222-4222-8222-222222222222';

const env = {
  CAMPAIGN_CONTROL_PLANE_URL: 'http://127.0.0.1:4020',
  CAMPAIGN_INTERNAL_SERVICE_TOKEN: 'service-token',
} as NodeJS.ProcessEnv;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createHttpCampaignControlPlane.deliverRevision', () => {
  const input = { jobId: JOB, workspaceId: WORKSPACE, campaignId: CAMPAIGN, plan: { a: 1 } };

  it('posts the raw plan with the service token and accepts 200/201/204', async () => {
    const fetchMock = vi.fn(async () => new Response('{"data":{}}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    await createHttpCampaignControlPlane(env).deliverRevision(input);

    const [url, init] = fetchMock.mock.calls[0]! as unknown as [URL, RequestInit];
    expect(String(url)).toBe('http://127.0.0.1:4020/api/internal/v1/campaign-revisions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-service-token']).toBe('service-token');
    expect(JSON.parse(String(init.body))).toEqual(input);
  });

  it('maps 422 CAMPAIGN_PLAN_INVALID with issues from error.details.issues', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: 'CAMPAIGN_PLAN_INVALID',
                message: '计划未通过校验',
                details: { issues: [{ path: 'goal.objective', message: 'required' }] },
              },
            }),
            { status: 422 },
          ),
      ),
    );
    const error = await createHttpCampaignControlPlane(env)
      .deliverRevision(input)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CampaignControlPlaneError);
    expect(error).toMatchObject({
      code: 'CAMPAIGN_PLAN_INVALID',
      options: { status: 422, issues: [{ path: 'goal.objective', message: 'required' }] },
    });
  });

  it('maps other 4xx to a non-retryable rejection and 5xx to an unavailable retry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":{"code":"CAMPAIGN_PLAN_JOB_NOT_FOUND"}}', { status: 404 })),
    );
    await expect(createHttpCampaignControlPlane(env).deliverRevision(input)).rejects.toMatchObject(
      { code: 'CAMPAIGN_PLAN_CALLBACK_REJECTED' },
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 503 })),
    );
    await expect(createHttpCampaignControlPlane(env).deliverRevision(input)).rejects.toMatchObject(
      { code: 'CAMPAIGN_CONTROL_PLANE_UNAVAILABLE' },
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    await expect(createHttpCampaignControlPlane(env).deliverRevision(input)).rejects.toMatchObject(
      { code: 'CAMPAIGN_CONTROL_PLANE_UNAVAILABLE' },
    );
  });

  it('fails closed when the control plane is not configured', async () => {
    await expect(
      createHttpCampaignControlPlane({} as NodeJS.ProcessEnv).deliverRevision(input),
    ).rejects.toMatchObject({ code: 'CAMPAIGN_CONTROL_PLANE_NOT_CONFIGURED' });
  });
});

describe('createHttpCampaignControlPlane.reportJobFailure', () => {
  const input = {
    jobId: JOB,
    workspaceId: WORKSPACE,
    error: 'SKILL_PLATFORM_DISABLED',
    issues: [{ path: '', message: 'disabled' }],
  };

  it('patches the job state and treats 404/409 as terminal', async () => {
    const fetchMock = vi.fn(async () => new Response('{"data":{}}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await createHttpCampaignControlPlane(env).reportJobFailure(input);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [URL, RequestInit];
    expect(String(url)).toBe('http://127.0.0.1:4020/api/internal/v1/campaign-plan-jobs/' + JOB);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({
      workspaceId: WORKSPACE,
      state: 'FAILED',
      error: 'SKILL_PLATFORM_DISABLED',
      issues: [{ path: '', message: 'disabled' }],
    });

    for (const status of [404, 409]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status })));
      await expect(
        createHttpCampaignControlPlane(env).reportJobFailure(input),
      ).resolves.toBeUndefined();
    }
  });

  it('keeps 5xx failures retryable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 502 })),
    );
    await expect(
      createHttpCampaignControlPlane(env).reportJobFailure(input),
    ).rejects.toMatchObject({ code: 'CAMPAIGN_CONTROL_PLANE_UNAVAILABLE' });
  });
});
