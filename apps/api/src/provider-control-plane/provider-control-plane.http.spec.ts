import { Module, VersioningType } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { ROLES_TO_SCOPES_POLICY } from '../auth/scopes';
import { ScopesGuard } from '../auth/scopes.guard';
import { TokenVerifier } from '../auth/token-verifier';
import { ProviderControlPlaneController } from './provider-control-plane.controller';
import { ProviderControlPlaneService } from './provider-control-plane.service';

describe('ProviderControlPlaneController HTTP contract', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('serves the versioned read model over HTTP with no-store', async () => {
    const list = vi.fn(async () => ({
      scope: { platform: [], workspace: [] },
      providers: [],
    }));
    @Module({
      controllers: [ProviderControlPlaneController],
      providers: [
        { provide: ProviderControlPlaneService, useValue: { list } },
        {
          provide: TokenVerifier,
          useValue: {
            verify: async () => ({
              userId: 'operator-1',
              workspaceId: '11111111-1111-4111-8111-111111111111',
              roles: ['ops'],
            }),
          },
        },
        { provide: ROLES_TO_SCOPES_POLICY, useValue: { resolve: () => ['ops:read'] } },
        Reflector,
        AuthGuard,
        ScopesGuard,
      ],
    })
    class ContractTestModule {}

    app = await NestFactory.create(ContractTestModule, { logger: false });
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.listen(0, '127.0.0.1');

    const address = app.getHttpServer().address();
    if (typeof address === 'string' || address === null) throw new Error('HTTP listener address unavailable');
    const origin = `http://127.0.0.1:${address.port}`;
    const unauthorized = await fetch(`${origin}/api/v1/provider-control-plane`);
    const response = await fetch(`${origin}/api/v1/provider-control-plane`, {
      headers: { authorization: 'Bearer local-contract-test' },
    });

    expect(unauthorized.status).toBe(401);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      data: { scope: { platform: [], workspace: [] }, providers: [] },
    });
    expect(list).toHaveBeenCalledOnce();
  });
});
