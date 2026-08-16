import { BadRequestException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ProviderQualityController } from './provider-quality.controller';

const ctx = { userId: 'u-1', workspaceId: 'ws-a', roles: ['owner'] };

describe('ProviderQualityController', () => {
  it('passes a bounded time window, minimum sample and explicit ranking metric', async () => {
    const rank = vi.fn(async () => ({ providers: [] }));
    const controller = new ProviderQualityController({ rank } as never);

    await controller.rank(ctx, '90', '5', 'conflict_rate');

    expect(rank).toHaveBeenCalledWith(ctx, { windowDays: 90, minRuns: 5, metric: 'conflict_rate' });
  });

  it.each([['0', '3', 'bound_rate'], ['366', '3', 'bound_rate'], ['30', '0', 'bound_rate'], ['30', '3', 'magic']])(
    'rejects invalid query values',
    async (windowDays, minRuns, metric) => {
      const controller = new ProviderQualityController({ rank: vi.fn() } as never);
      await expect(controller.rank(ctx, windowDays, minRuns, metric)).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it('publishes a closed response schema and 400/401/403 errors in OpenAPI', () => {
    const document = JSON.parse(readFileSync(
      resolve(process.cwd(), '../../packages/contracts/openapi/openapi.json'),
      'utf8',
    )) as { paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>; components: { schemas: Record<string, Record<string, unknown>> } };
    const operation = document.paths['/api/v1/provider-quality-rankings']?.get;
    expect(Object.keys(operation?.responses ?? {}).sort()).toEqual(['200', '400', '401', '403']);
    expect(document.components.schemas.ProviderQualityRankingDto).toMatchObject({
      type: 'object',
      required: expect.arrayContaining(['window', 'minimumRunCount', 'rankingMetric', 'interpretation', 'providers']),
    });
  });
});
