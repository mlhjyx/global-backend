import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BuildsController } from './builds.controller';

const CTX = { userId: 'u1', workspaceId: '11111111-1111-4111-8111-111111111111', roles: [] };

describe('BuildsController public progress response', () => {
  it('does not expose persisted raw worker/provider errors', async () => {
    const builds = {
      get: async () => ({
        id: '22222222-2222-4222-8222-222222222222',
        kind: 'refurbish',
        status: 'failed',
        phase: 'P2_assets',
        progress: 0.4,
        steps: null,
        costSummary: null,
        error: 'connect ECONNREFUSED 10.0.0.7:7233 secret-token=abc',
        startedAt: new Date('2026-07-17T00:00:00.000Z'),
        finishedAt: new Date('2026-07-17T00:01:00.000Z'),
      }),
    };
    const controller = new BuildsController(builds as never);

    const response = await controller.get(CTX, '22222222-2222-4222-8222-222222222222');

    expect(response.data.error).toBe('build failed');
    expect(JSON.stringify(response)).not.toContain('10.0.0.7');
    expect(JSON.stringify(response)).not.toContain('secret-token');
  });

  it('keeps error null when the run has no persisted error', async () => {
    const builds = {
      get: async () => ({
        id: '22222222-2222-4222-8222-222222222222',
        kind: 'refurbish',
        status: 'running',
        phase: null,
        progress: 0.1,
        steps: null,
        costSummary: null,
        error: null,
        startedAt: null,
        finishedAt: null,
      }),
    };
    const controller = new BuildsController(builds as never);

    const response = await controller.get(CTX, '22222222-2222-4222-8222-222222222222');

    expect(response.data.error).toBeNull();
  });

  it('exports the non-null progress shape as strings plus a step array', () => {
    const spec = JSON.parse(
      readFileSync(resolve(process.cwd(), '../../packages/contracts/openapi/openapi.json'), 'utf8'),
    ) as {
      components: {
        schemas: {
          BuildStatusResponseDto: {
            properties: Record<string, { type?: string; nullable?: boolean; items?: unknown }>;
          };
        };
      };
    };
    const properties = spec.components.schemas.BuildStatusResponseDto.properties;

    expect(properties.phase).toMatchObject({ type: 'string', nullable: true });
    expect(properties.error).toMatchObject({ type: 'string', nullable: true });
    expect(properties.steps).toMatchObject({ type: 'array', nullable: true });
    expect(properties.steps.items).toMatchObject({
      type: 'object',
      required: ['key', 'status'],
      properties: {
        key: { type: 'string' },
        status: { type: 'string' },
      },
    });
  });
});
