import { INestApplication, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module';
import { buildOpenApi } from '../openapi-document';
import { ACQUISITION_CONTROLLER_SCOPE_INVENTORY } from './acquisition-scope-inventory';

const ORIGINAL_ENV = { ...process.env };
let app: INestApplication;

beforeAll(async () => {
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'test',
    DEPLOYMENT_STAGE: 'development',
    API_BIND_HOST: '127.0.0.1',
    AUTH_ALLOW_DEV_TOKENS: 'true',
    AUTH_ROLE_SCOPE_MAP: JSON.stringify({
      'test.reader': ['acquisition:read'],
    }),
  };
  app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
});

afterAll(async () => {
  await app?.close();
  process.env = { ...ORIGINAL_ENV };
});

describe('generated OpenAPI authorization inventory', () => {
  it('publishes exact x-required-scopes for every inventoried operation', () => {
    const document = buildOpenApi(app);
    const operations = Object.values(document.paths ?? {}).flatMap((path) =>
      Object.values(path ?? {}).filter(
        (operation): operation is Record<string, unknown> =>
          Boolean(operation) && typeof operation === 'object' && 'operationId' in operation,
      ),
    );
    const byOperationId = new Map(operations.map((operation) => [operation.operationId, operation]));

    for (const [controllerName, controller] of Object.entries(ACQUISITION_CONTROLLER_SCOPE_INVENTORY)) {
      for (const [operationName, expectedScopes] of Object.entries(controller.operations)) {
        const operationId = `${controllerName}_${operationName}_v1`;
        expect(byOperationId.get(operationId), `${operationId} missing`).toBeDefined();
        expect(byOperationId.get(operationId)?.['x-required-scopes']).toEqual(expectedScopes);
      }
    }
  });
});
