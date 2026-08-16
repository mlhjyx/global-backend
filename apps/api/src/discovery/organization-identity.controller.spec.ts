import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { ScopesGuard } from '../auth/scopes.guard';
import { DiscoveryController } from './discovery.controller';
import { OrganizationIdentityController } from './organization-identity.controller';

type ApiResponseMetadata = Record<
  string,
  {
    schema?: {
      required?: string[];
      properties?: {
        error?: {
          required?: string[];
          properties?: { code?: { enum?: string[] }; message?: unknown };
        };
      };
    };
  }
>;

function responseMetadata(controller: object, method: string): ApiResponseMetadata {
  const handler = (controller as Record<string, unknown>)[method];
  return Reflect.getMetadata('swagger/apiResponse', handler as object) as ApiResponseMetadata;
}

function executionContext(
  handler: ReturnType<ExecutionContext['getHandler']>,
  controller: ReturnType<ExecutionContext['getClass']>,
  request: object,
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function expectErrorEnvelope(response: ApiResponseMetadata[string] | undefined): void {
  expect(response?.schema?.required).toContain('error');
  expect(response?.schema?.properties?.error?.required).toEqual(['code', 'message']);
  expect(response?.schema?.properties?.error?.properties?.code?.enum?.length).toBeGreaterThan(0);
  expect(response?.schema?.properties?.error?.properties?.message).toEqual({ type: 'string' });
}

describe('Organization Identity controller authorization and OpenAPI contract', () => {
  it('returns stable 403 when acquisition:identity:review is missing', () => {
    const guard = new ScopesGuard(new Reflector());
    const context = executionContext(
      OrganizationIdentityController.prototype.list,
      OrganizationIdentityController,
      { requestContext: { scopes: ['acquisition:read'] } },
    );

    let caught: unknown;
    try {
      guard.canActivate(context);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ForbiddenException);
    expect(caught).toMatchObject({
      status: 403,
      response: { error: { code: 'SCOPE_REQUIRED' } },
    });
  });

  it.each([
    ['list', ['200', '400', '403']],
    ['get', ['200', '400', '403', '404']],
    ['decide', ['202', '400', '403', '404', '409', '412', '428']],
    ['getMapping', ['200', '400', '403', '404']],
    ['split', ['202', '400', '403', '404', '409', '412', '428']],
  ])('%s declares every reachable identity response', (method, statuses) => {
    const metadata = responseMetadata(OrganizationIdentityController.prototype, method);
    expect(Object.keys(metadata).sort()).toEqual([...statuses].sort());
    for (const status of statuses.filter((value) => Number(value) >= 400)) {
      expectErrorEnvelope(metadata[status]);
    }
  });

  it('canonical company detail declares identity-aware validation, scope and tenant-hidden not-found errors', () => {
    const metadata = responseMetadata(DiscoveryController.prototype, 'getCompany');
    expect(Object.keys(metadata).sort()).toEqual(['200', '400', '403', '404']);
    for (const status of ['400', '403', '404']) expectErrorEnvelope(metadata[status]);
  });

  it('documents stable idempotency, ETag and missing-precondition codes', () => {
    const decide = responseMetadata(OrganizationIdentityController.prototype, 'decide');
    const split = responseMetadata(OrganizationIdentityController.prototype, 'split');
    expect(decide['409']?.schema?.properties?.error?.properties?.code?.enum).toContain('IDEMPOTENCY_CONFLICT');
    expect(split['409']?.schema?.properties?.error?.properties?.code?.enum).toContain('IDENTITY_SPLIT_ALREADY_PENDING');
    expect(split['409']?.schema?.properties?.error?.properties?.code?.enum).toContain('IDENTITY_MERGE_PROJECTION_UNSETTLED');
    for (const metadata of [decide, split]) {
      expect(metadata['412']?.schema?.properties?.error?.properties?.code?.enum).toEqual([
        'IDENTITY_REVISION_CONFLICT',
      ]);
      expect(metadata['428']?.schema?.properties?.error?.properties?.code?.enum).toEqual([
        'PRECONDITION_REQUIRED',
      ]);
    }
  });
});
