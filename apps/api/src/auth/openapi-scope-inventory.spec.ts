import { INestApplication, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module';
import { buildOpenApi } from '../openapi-document';
import { ACQUISITION_CONTROLLER_SCOPE_INVENTORY } from './acquisition-scope-inventory';

const ORIGINAL_ENV = { ...process.env };
let app: INestApplication;

function operationsOf(document: ReturnType<typeof buildOpenApi>): Array<Record<string, unknown>> {
  return Object.values(document.paths ?? {}).flatMap((path) =>
    Object.values(path ?? {}).filter(
      (operation): operation is Record<string, unknown> =>
        Boolean(operation) && typeof operation === 'object' && 'operationId' in operation,
    ),
  );
}

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
    const operations = operationsOf(document);
    const byOperationId = new Map(operations.map((operation) => [operation.operationId, operation]));

    for (const [controllerName, controller] of Object.entries(ACQUISITION_CONTROLLER_SCOPE_INVENTORY)) {
      for (const [operationName, expectedScopes] of Object.entries(controller.operations)) {
        const operationId = `${controllerName}_${operationName}_v1`;
        expect(byOperationId.get(operationId), `${operationId} missing`).toBeDefined();
        expect(byOperationId.get(operationId)?.['x-required-scopes']).toEqual(expectedScopes);
      }
    }
  });

  it('publishes one unified 401/403 error schema for every bearer-protected operation', () => {
    const document = buildOpenApi(app);
    const protectedOperations = operationsOf(document).filter(
      (operation) => Array.isArray(operation.security) && operation.security.length > 0,
    );

    expect(protectedOperations.length).toBeGreaterThan(0);
    expect(document.components?.schemas?.AuthErrorResponse).toMatchObject({
      type: 'object',
      required: ['error'],
      properties: {
        error: {
          type: 'object',
          required: ['code', 'message'],
          properties: {
            code: { type: 'string' },
            message: { type: 'string' },
            details: { type: 'object' },
          },
        },
      },
    });
    expect(document.components?.responses?.AuthUnauthorized).toBeDefined();
    expect(document.components?.responses?.AuthForbidden).toBeDefined();

    for (const operation of protectedOperations) {
      const responses = operation.responses as Record<string, unknown> | undefined;
      expect(responses?.['401'], `${String(operation.operationId)} missing unified 401`).toEqual({
        $ref: '#/components/responses/AuthUnauthorized',
      });
      expect(responses?.['403'], `${String(operation.operationId)} missing unified 403`).toEqual({
        $ref: '#/components/responses/AuthForbidden',
      });
    }
  });

  it('does not expose the personal-email lawful-basis bypass in public request DTOs', () => {
    const schemas = buildOpenApi(app).components?.schemas as
      | Record<string, { properties?: Record<string, unknown> }>
      | undefined;

    expect(schemas?.VerifyContactPointDto).toBeDefined();
    expect(schemas?.GuessEmailsDto).toBeDefined();
    expect(schemas?.VerifyContactPointDto?.properties).not.toHaveProperty('allowPersonalWithoutBasis');
    expect(schemas?.GuessEmailsDto?.properties).not.toHaveProperty('allowPersonalWithoutBasis');
  });

  it('publishes a bearer-protected, closed, non-PII health ops contract without protecting public probes', () => {
    const document = buildOpenApi(app);
    const ops = document.paths['/api/v1/health/ops']?.get as
      | Record<string, unknown>
      | undefined;
    expect(ops?.security).toEqual([{ bearer: [] }]);
    expect(ops?.['x-required-scopes']).toEqual(['ops:read']);
    expect(ops?.parameters ?? []).toEqual([]);
    expect(ops?.requestBody).toBeUndefined();
    expect(document.paths['/api/v1/health/live']?.get?.security).toBeUndefined();
    expect(document.paths['/api/v1/health/ready']?.get?.security).toBeUndefined();
    expect(document.paths['/api/v1/health/build']?.get?.security).toBeUndefined();
    expect(document.paths['/api/v1/health/db']?.get?.security).toBeUndefined();

    const schema = (
      ops?.responses as Record<
        string,
        { content?: Record<string, { schema?: Record<string, unknown> }> }
      >
    )?.['200']?.content?.['application/json']?.schema;
    expect(schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: [
        'schemaVersion',
        'observedAt',
        'runtime',
        'workspace',
        'global',
        'proof',
      ],
    });
    expect(JSON.stringify(schema)).not.toMatch(
      /workspaceId|userId|eventId|workflowId|runId|accountId|payload|lastError|freezeReason|authorizationHash|personal/iu,
    );
  });
});
