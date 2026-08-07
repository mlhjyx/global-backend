import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import { AcquisitionService } from './acquisition.service';
import type { SourceAdapterRegistry } from './source-adapter';

describe('AcquisitionService durable diagnostics', () => {
  it('persists and returns only a digest when a source throws arbitrary text', async () => {
    const update = vi.fn(async () => ({}));
    const prisma = {
      monitoredSource: {
        findUnique: vi.fn(async () => ({
          id: 'source-1',
          status: 'ACTIVE',
          providerKey: 'directory',
          sourceKey: 'directory:test',
          config: {},
        })),
      },
      sourceFetch: {
        create: vi.fn(async () => ({ id: 'fetch-1' })),
        update,
      },
    } as unknown as PrismaService;
    const registry = {
      get: vi.fn(() => ({
        fetch: vi.fn(async () => {
          throw new Error('provider echoed Jane Doe and private body text');
        }),
      })),
    } as unknown as SourceAdapterRegistry;

    const result = await new AcquisitionService({ prisma, registry }).acquire(
      'source-1',
    );

    expect(result.status).toBe('FAILED');
    expect(result.reason).toMatch(/^ERROR_TEXT_SHA256:[0-9a-f]{64}$/);
    expect(JSON.stringify(result)).not.toContain('Jane Doe');
    expect(update).toHaveBeenCalledWith({
      where: { id: 'fetch-1' },
      data: expect.objectContaining({
        status: 'FAILED',
        error: result.reason,
      }),
    });
  });
});
