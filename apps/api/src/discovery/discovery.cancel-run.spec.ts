import { describe, expect, it, vi } from 'vitest';
import { DiscoveryService } from './discovery.service';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const CTX = { workspaceId: WORKSPACE_ID, userId: 'user-1', roles: [] } as never;

function makeService(status: string | null, cancelImpl?: () => Promise<void>) {
  const cancel = vi.fn(cancelImpl ?? (async () => undefined));
  const prisma = {
    withWorkspace: async <T>(_ws: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn({
        discoveryRun: {
          findUnique: async () => (status === null ? null : { id: RUN_ID, status }),
        },
      }),
  };
  const temporal = {
    client: { workflow: { getHandle: vi.fn(() => ({ cancel })) } },
  };
  const service = new DiscoveryService(
    prisma as never,
    {} as never,
    {} as never,
    undefined,
    temporal as never,
  );
  return { service, cancel, temporal };
}

describe('M0④ 停止深挖（RequestCancel）', () => {
  it('requests cancellation of the run workflow and answers CANCEL_REQUESTED', async () => {
    const { service, cancel, temporal } = makeService('RUNNING');
    await expect(service.cancelRun(CTX, RUN_ID)).resolves.toEqual({
      runId: RUN_ID,
      status: 'CANCEL_REQUESTED',
    });
    expect(temporal.client.workflow.getHandle).toHaveBeenCalledWith(
      `ws:${WORKSPACE_ID}:discovery:${RUN_ID}`,
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('falls back to legacy unprefixed workflowId when tenant-prefixed execution is not found', async () => {
    const cancelPrefixed = vi.fn(async () => {
      throw new Error('workflow execution not found');
    });
    const cancelLegacy = vi.fn(async () => undefined);
    const getHandle = vi.fn((wfId: string) => ({
      cancel: wfId.startsWith('ws:') ? cancelPrefixed : cancelLegacy,
    }));
    const prisma = {
      withWorkspace: async <T>(_ws: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
        fn({
          discoveryRun: {
            findUnique: async () => ({ id: RUN_ID, status: 'RUNNING' }),
          },
        }),
    };
    const service = new DiscoveryService(
      prisma as never,
      {} as never,
      {} as never,
      undefined,
      { client: { workflow: { getHandle } } } as never,
    );
    await expect(service.cancelRun(CTX, RUN_ID)).resolves.toEqual({
      runId: RUN_ID,
      status: 'CANCEL_REQUESTED',
    });
    expect(getHandle).toHaveBeenNthCalledWith(1, `ws:${WORKSPACE_ID}:discovery:${RUN_ID}`);
    expect(getHandle).toHaveBeenNthCalledWith(2, `discovery-${RUN_ID}`);
    expect(cancelLegacy).toHaveBeenCalledTimes(1);
  });

  it('is idempotent for a run that already finished', async () => {
    for (const status of ['DONE', 'PARTIAL', 'FAILED', 'CANCELLED']) {
      const { service, cancel } = makeService(status);
      await expect(service.cancelRun(CTX, RUN_ID)).resolves.toEqual({ runId: RUN_ID, status });
      expect(cancel).not.toHaveBeenCalled();
    }
  });

  it('404s an unknown run', async () => {
    const { service } = makeService(null);
    await expect(service.cancelRun(CTX, RUN_ID)).rejects.toMatchObject({
      status: 404,
      response: { error: { code: 'NOT_FOUND' } },
    });
  });

  it('treats a not-yet-started workflow as cancelled-before-start', async () => {
    const { service } = makeService('RUNNING', async () => {
      throw new Error('workflow execution not found');
    });
    await expect(service.cancelRun(CTX, RUN_ID)).resolves.toEqual({
      runId: RUN_ID,
      status: 'CANCEL_REQUESTED',
    });
  });
});
