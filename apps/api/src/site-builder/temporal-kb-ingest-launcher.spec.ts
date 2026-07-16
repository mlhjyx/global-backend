import { describe, expect, it, vi } from 'vitest';
import { TemporalKbIngestLauncher } from './temporal-refurbish-launcher';

describe('TemporalKbIngestLauncher R2-A2', () => {
  it('workflowId 与 workflow input 都绑定同一个 assetId', async () => {
    const start = vi.fn(async () => undefined);
    const launcher = new TemporalKbIngestLauncher({
      client: { workflow: { start } },
    } as never);

    await launcher.launchKbIngest({
      workspaceId: 'ws-1',
      siteId: 'site-1',
      assetId: 'asset-1',
    });

    expect(start).toHaveBeenCalledWith(
      'kbIngestWorkflow',
      expect.objectContaining({
        workflowId: 'site-kb-asset-1',
        args: [{ workspaceId: 'ws-1', siteId: 'site-1', assetId: 'asset-1' }],
      }),
    );
  });
});
