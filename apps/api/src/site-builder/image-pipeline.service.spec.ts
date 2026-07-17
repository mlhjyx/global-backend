import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
import type { ImagePipelineRunner } from './image-pipeline-runner';
import { ImagePipelineService } from './image-pipeline.service';
import type { StorageService } from './storage.service';

function serviceWithAssets(ids: string[]): ImagePipelineService {
  const prisma = {
    withWorkspace: vi.fn(async (_workspaceId, fn) =>
      fn({ asset: { findMany: vi.fn(async () => ids.map((id) => ({ id }))) } }),
    ),
  } as unknown as PrismaService;
  return new ImagePipelineService(
    prisma,
    {} as StorageService,
    {} as ImagePipelineRunner,
  );
}

describe('ImagePipelineService site-level isolation', () => {
  it('keeps processing sibling images after one ordinary image failure', async () => {
    const service = serviceWithAssets(['bad', 'good']);
    vi.spyOn(service, 'processAsset').mockImplementation(async ({ assetId }) => {
      if (assetId === 'bad') throw new Error('decoder rejected input');
      return {
        assetId,
        status: 'done',
        variants: 15,
        reused: 0,
        qualityWarnings: [],
      };
    });

    await expect(service.processSiteImages({ workspaceId: 'ws', siteId: 'site' })).resolves.toMatchObject({
      status: 'degraded',
      processed: 1,
      failed: 1,
      variants: 15,
    });
  });

  it('never converts cancellation into an ordinary degraded image result', async () => {
    const service = serviceWithAssets(['cancelled']);
    const abort = new AbortController();
    const cancellation = Object.assign(new Error('cancelled'), { name: 'CancelledFailure' });
    vi.spyOn(service, 'processAsset').mockImplementation(async () => {
      abort.abort(cancellation);
      throw cancellation;
    });

    await expect(
      service.processSiteImages({ workspaceId: 'ws', siteId: 'site' }, abort.signal),
    ).rejects.toBe(cancellation);
  });
});
