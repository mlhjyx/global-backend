import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';

interface SchemaNode {
  type?: string;
  additionalProperties?: boolean;
  required?: string[];
  enum?: Array<string | boolean>;
  properties?: Record<string, SchemaNode>;
  oneOf?: SchemaNode[];
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

function schema(path: string, status: string): SchemaNode | undefined {
  const document = JSON.parse(
    readFileSync(resolve(process.cwd(), '../../packages/contracts/openapi/openapi.json'), 'utf8'),
  ) as {
    paths: Record<
      string,
      {
        get?: {
          responses?: Record<string, { content?: Record<string, { schema?: SchemaNode }> }>;
        };
      }
    >;
  };
  return document.paths[path]?.get?.responses?.[status]?.content?.['application/json']?.schema;
}

describe('layered health OpenAPI contract', () => {
  it('publishes a closed dependency-free liveness response', () => {
    expect(schema('/api/v1/health/live', '200')).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['status', 'service', 'ts'],
    });
  });

  it('publishes a closed attested or explicitly unattested build identity', () => {
    const response = schema('/api/v1/health/build', '200');
    expect(response).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['status', 'service', 'build'],
    });
    const build = response?.properties?.build;
    expect(build?.oneOf).toHaveLength(2);
    expect(build?.oneOf?.[0]).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: [
        'attested',
        'schema_version',
        'build_sha',
        'built_at',
        'artifact_digest',
        'artifact_manifest_digest',
        'sbom_digest',
        'source_tree_digest',
        'renderer_digest',
        'migration_revision',
        'schema_digest',
        'image_digest',
      ],
    });
    expect(build?.oneOf?.[1]).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['attested', 'schema_version', 'code'],
    });
  });

  it('publishes identical closed readiness bodies for 200 and 503', () => {
    const success = schema('/api/v1/health/ready', '200');
    const unavailable = schema('/api/v1/health/ready', '503');
    expect(success).toEqual(unavailable);
    expect(success).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['status', 'service', 'ts', 'components', 'capabilities'],
    });
    expect(success?.properties?.capabilities).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['execution_budget_jwks', 'workspace_budget_authority', 'platform_budget_authority'],
    });
    expect(success?.properties?.components).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: [
        'database',
        'migration',
        'temporal_control_plane',
        'worker',
        'outbox_relay',
        'api_runtime',
        'storage',
        'redis',
        'model_gateway',
        'renderer',
        'browser',
        'budget_grant_verification',
        'auth_jwks',
        'admission',
      ],
    });
  });

  it('publishes exact closed ComponentStatus unions for hard components and additive capabilities', () => {
    const response = schema('/api/v1/health/ready', '200');
    const candidates = [
      response?.properties?.components?.properties?.database,
      response?.properties?.capabilities?.properties?.execution_budget_jwks,
    ];

    for (const candidate of candidates) {
      expect(candidate?.oneOf).toHaveLength(3);
      expect(candidate?.oneOf).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'object',
            additionalProperties: false,
            required: ['status'],
            properties: {
              status: { type: 'string', enum: ['ok'] },
            },
          }),
          expect.objectContaining({
            type: 'object',
            additionalProperties: false,
            required: ['status', 'code'],
          }),
        ]),
      );
      const validate = new Ajv2020({ strict: true }).compile(candidate ?? {});
      expect(validate({ status: 'ok' })).toBe(true);
      expect(validate({ status: 'ok', code: 'UNEXPECTED' })).toBe(false);
      expect(validate({ status: 'failed' })).toBe(false);
      expect(
        validate({ status: 'failed', code: 'DATABASE_UNAVAILABLE' }),
      ).toBe(true);
      expect(validate({ status: 'not_proven' })).toBe(false);
      expect(
        validate({
          status: 'not_proven',
          code: 'RUNTIME_READINESS_SNAPSHOT_UNAVAILABLE',
        }),
      ).toBe(true);
      expect(validate({ status: 'failed', code: 'raw database error' })).toBe(
        false,
      );
    }
  });
});
