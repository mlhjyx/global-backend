import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface Operation {
  security?: Array<Record<string, string[]>>;
  parameters?: Array<{ name: string; in: string }>;
  responses: Record<string, unknown>;
  'x-required-scopes'?: string[];
  requestBody?: {
    content: { 'application/json': { schema: Record<string, unknown> } };
  };
}

interface OpenApiDocument {
  paths: Record<string, { post?: Operation }>;
  components: {
    schemas: Record<
      string,
      {
        additionalProperties?: boolean;
        required?: string[];
        properties?: Record<string, Record<string, unknown>>;
      }
    >;
  };
}

function document(): OpenApiDocument {
  return JSON.parse(
    readFileSync(
      resolve(process.cwd(), '../../packages/contracts/openapi/openapi.json'),
      'utf8',
    ),
  ) as OpenApiDocument;
}

function errorCodes(path: string, status: string): string[] {
  const response = document().paths[path]?.post?.responses[status] as
    | {
        content?: {
          'application/json'?: {
            schema?: {
              properties?: {
                error?: {
                  properties?: { code?: { enum?: string[] } };
                };
              };
            };
          };
        };
      }
    | undefined;
  return (
    response?.content?.['application/json']?.schema?.properties?.error
      ?.properties?.code?.enum ?? []
  );
}

describe('Site Build technical budget quote OpenAPI', () => {
  it.each([
    '/api/v1/site-builder/intake-budget-quote',
    '/api/v1/site-builder/sites/{id}/build-budget-quote',
  ])('publishes authenticated acquisition:write quote operation %s without a Budget Grant header', (path) => {
    const operation = document().paths[path]?.post;

    expect(operation).toBeDefined();
    expect(operation?.security).toEqual([{ bearer: [] }]);
    expect(operation?.['x-required-scopes']).toEqual(['acquisition:write']);
    expect(operation?.parameters ?? []).not.toContainEqual(
      expect.objectContaining({ name: 'X-Site-Build-Budget-Grant' }),
    );
    expect(operation?.responses).toHaveProperty('200');
    expect(operation?.responses).toHaveProperty('503');
    expect(operation?.responses).not.toHaveProperty('402');
  });

  it('publishes the closed technical quote response instead of a customer billing schema', () => {
    const schema = document().components.schemas
      .SiteBuildTechnicalBudgetQuoteResponseDto;

    expect(schema).toMatchObject({
      additionalProperties: false,
      required: [
        'schemaVersion',
        'operation',
        'siteId',
        'requestSha256',
        'currency',
        'unit',
        'requiredCapMicrousd',
        'policyRevision',
        'expiresAt',
      ],
    });
    expect(schema.properties?.schemaVersion).toMatchObject({
      enum: ['site-builder-technical-budget-quote/v1'],
    });
    expect(schema.properties?.requiredCapMicrousd).toMatchObject({
      type: 'string',
      pattern: '^[1-9][0-9]*$',
    });
    expect(JSON.stringify(schema)).not.toMatch(
      /customer|balance|subscription|prepaid|invoice/i,
    );
  });

  it('publishes the real validation and unsupported-option errors at the HTTP boundary', () => {
    const intakePath = '/api/v1/site-builder/intake-budget-quote';
    const refurbishPath =
      '/api/v1/site-builder/sites/{id}/build-budget-quote';

    expect(errorCodes(intakePath, '400')).toEqual(['VALIDATION_ERROR']);
    expect(document().paths[intakePath]?.post?.responses).not.toHaveProperty(
      '422',
    );
    expect(errorCodes(refurbishPath, '400')).toEqual(['VALIDATION_ERROR']);
    expect(errorCodes(refurbishPath, '422')).toEqual([
      'BUILD_OPTION_UNAVAILABLE',
    ]);
  });
});
