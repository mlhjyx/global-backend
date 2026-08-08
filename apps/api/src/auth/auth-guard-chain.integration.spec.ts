import {
  Controller,
  Get,
  INestApplication,
  Module,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobalHttpExceptionFilter } from '../common/http-exception.filter';
import { ROLE_SCOPE_POLICY } from './auth-scopes';
import { AuthGuard } from './auth.guard';
import { RequireScopes } from './require-scopes.decorator';
import { ScopesGuard } from './scopes.guard';
import { TokenVerifier } from './token-verifier';

const verify = vi.fn(async (token: string) => {
  if (token === 'reader') {
    return { userId: 'reader', workspaceId: '11111111-1111-4111-8111-111111111111', roles: ['reader'] };
  }
  if (token === 'personal-reader') {
    return {
      userId: 'personal-reader',
      workspaceId: '11111111-1111-4111-8111-111111111111',
      roles: ['personal-reader'],
    };
  }
  throw new UnauthorizedException({
    error: { code: 'TOKEN_INVALID', message: 'token verification failed' },
  });
});

const permits = vi.fn((roles: readonly string[], required: readonly string[]) => {
  expect(required).toEqual(['acquisition:read', 'personal-data:read']);
  return roles.includes('personal-reader');
});

@Controller('guard-order')
@UseGuards(AuthGuard)
class GuardOrderController {
  @Get()
  @RequireScopes('acquisition:read', 'personal-data:read')
  get() {
    return { ok: true };
  }
}

@Module({
  controllers: [GuardOrderController],
  providers: [
    AuthGuard,
    ScopesGuard,
    { provide: TokenVerifier, useValue: { verify } },
    { provide: ROLE_SCOPE_POLICY, useValue: { permits } },
  ],
})
class GuardOrderModule {}

describe('real Nest AuthGuard -> ScopesGuard request chain', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    app = await NestFactory.create(GuardOrderModule, { logger: false });
    app.useGlobalFilters(new GlobalHttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  beforeEach(() => {
    verify.mockClear();
    permits.mockClear();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('returns 401 before scope evaluation when the bearer token is missing', async () => {
    const response = await fetch(`${baseUrl}/guard-order`);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: 'TOKEN_MISSING', message: 'missing bearer token' },
    });
    expect(verify).not.toHaveBeenCalled();
    expect(permits).not.toHaveBeenCalled();
  });

  it('returns the generic 401 before scope evaluation when verification fails', async () => {
    const response = await fetch(`${baseUrl}/guard-order`, {
      headers: { authorization: 'Bearer invalid' },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: 'TOKEN_INVALID', message: 'token verification failed' },
    });
    expect(verify).toHaveBeenCalledOnce();
    expect(permits).not.toHaveBeenCalled();
  });

  it('returns 403 after one successful verification when all required scopes are not granted', async () => {
    const response = await fetch(`${baseUrl}/guard-order`, {
      headers: { authorization: 'Bearer reader' },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: 'INSUFFICIENT_SCOPE',
        message: 'the authenticated role is not authorized for this operation',
        details: { requiredScopes: ['acquisition:read', 'personal-data:read'] },
      },
    });
    expect(verify).toHaveBeenCalledOnce();
    expect(permits).toHaveBeenCalledOnce();
  });

  it('allows the request after one successful verification and all-of scope evaluation', async () => {
    const response = await fetch(`${baseUrl}/guard-order`, {
      headers: { authorization: 'Bearer personal-reader' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(verify).toHaveBeenCalledOnce();
    expect(permits).toHaveBeenCalledOnce();
  });
});
