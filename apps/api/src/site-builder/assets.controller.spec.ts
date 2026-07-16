import { describe, expect, it } from 'vitest';
import { AssetsController } from './assets.controller';

const CTX = {
  userId: 'u1',
  workspaceId: '11111111-1111-4111-8111-111111111111',
  roles: [],
};
const SITE_ID = '22222222-2222-4222-8222-222222222222';

describe('AssetsController public contract', () => {
  it('list：不返回持久化的 raw Asset.error，只返回稳定码与泛化消息', async () => {
    const assets = {
      list: async () => [
        {
          id: '33333333-3333-4333-8333-333333333333',
          kind: 'doc',
          filename: 'catalog.pdf',
          mime: 'application/pdf',
          sizeBytes: 123,
          processingStatus: 'queued',
          contentHash: 'a'.repeat(64),
          processingErrorCode: 'KB_STORAGE_UNAVAILABLE',
          error: 'MinIO http://internal-storage:9000 accessKey=secret',
          createdAt: new Date('2026-07-17T00:00:00.000Z'),
        },
      ],
    };
    const launcher = { launchKbIngest: async () => undefined };
    const controller = new AssetsController(assets as never, launcher as never);

    const response = await controller.list(CTX, SITE_ID);
    const serialized = JSON.stringify(response);

    expect(response.data[0]).toMatchObject({
      processingErrorCode: 'KB_STORAGE_UNAVAILABLE',
      error: 'Asset processing is temporarily unavailable.',
    });
    expect(serialized).not.toContain('internal-storage');
    expect(serialized).not.toContain('accessKey');
  });
});
