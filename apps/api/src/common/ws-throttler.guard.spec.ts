import { describe, expect, it } from 'vitest';
import { WsThrottlerGuard } from './ws-throttler.guard';

class TestGuard extends WsThrottlerGuard {
  tracker(req: Record<string, unknown>): Promise<string> {
    return this.getTracker(req);
  }
}

describe('WsThrottlerGuard tracker boundary', () => {
  const guard = Object.create(TestGuard.prototype) as TestGuard;

  it('prefers the authenticated workspace identity', async () => {
    await expect(guard.tracker({ ctx: { workspaceId: 'workspace-1' }, ip: '127.0.0.1' })).resolves.toBe(
      'ws:workspace-1',
    );
  });

  it('falls back from request IP to socket address and finally a closed unknown key', async () => {
    await expect(guard.tracker({ ip: '203.0.113.10' })).resolves.toBe('ip:203.0.113.10');
    await expect(guard.tracker({ socket: { remoteAddress: '203.0.113.11' } })).resolves.toBe(
      'ip:203.0.113.11',
    );
    await expect(guard.tracker({})).resolves.toBe('ip:unknown');
  });
});
