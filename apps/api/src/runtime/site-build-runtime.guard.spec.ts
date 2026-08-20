import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { SiteBuildRuntimeGuard } from './site-build-runtime.guard';

describe('SiteBuildRuntimeGuard', () => {
  it('allows a build only when the shared runtime report is ready', async () => {
    const readiness = { check: vi.fn(async () => ({ status: 'ready', components: {} })) };
    await expect(
      new SiteBuildRuntimeGuard(readiness as never).assertReady(),
    ).resolves.toBeUndefined();
  });

  it('returns the stable public error without leaking dependency diagnostics', async () => {
    const readiness = {
      check: vi.fn(async () => ({
        status: 'not_ready',
        components: {
          database: { status: 'failed', code: 'DATABASE_UNAVAILABLE' },
          worker: { status: 'failed', code: 'MATCHING_WORKER_NOT_READY' },
        },
        internal: 'postgresql://owner:secret@db/customer',
      })),
    };
    const guard = new SiteBuildRuntimeGuard(readiness as never);

    let error: unknown;
    try {
      await guard.assertReady();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toEqual({
      error: {
        code: 'SITE_BUILD_RUNTIME_NOT_READY',
        message: 'site build runtime is not ready',
        details: {
          failedComponents: [
            { component: 'database', code: 'DATABASE_UNAVAILABLE' },
            { component: 'worker', code: 'MATCHING_WORKER_NOT_READY' },
          ],
        },
      },
    });
    expect(JSON.stringify((error as ServiceUnavailableException).getResponse())).not.toContain(
      'secret',
    );
  });
});
