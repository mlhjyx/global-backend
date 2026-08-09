import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface SchemaNode {
  type?: string;
  additionalProperties?: boolean;
  required?: string[];
  enum?: Array<string | boolean>;
  properties?: Record<string, SchemaNode>;
  oneOf?: SchemaNode[];
}

function schema(path: string, status: string): SchemaNode | undefined {
  const document = JSON.parse(
    readFileSync(
      resolve(process.cwd(), '../../packages/contracts/openapi/openapi.json'),
      'utf8',
    ),
  ) as {
    paths: Record<
      string,
      {
        get?: {
          responses?: Record<
            string,
            { content?: Record<string, { schema?: SchemaNode }> }
          >;
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
        'migration_revision',
        'schema_digest',
      ],
    });
    expect(build?.oneOf?.[1]).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['attested', 'schema_version'],
    });
  });

  it('publishes identical closed readiness bodies for 200 and 503', () => {
    const success = schema('/api/v1/health/ready', '200');
    const unavailable = schema('/api/v1/health/ready', '503');
    expect(success).toEqual(unavailable);
    expect(success).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['status', 'service', 'ts', 'components'],
    });
    expect(success?.properties?.components).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: [
        'database',
        'temporal_control_plane',
        'worker',
        'outbox_relay',
        'admission',
      ],
    });
  });
});
