import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTHORIZATION_SCOPES } from './scopes';

interface Operation {
  security?: Array<Record<string, string[]>>;
  'x-required-scopes'?: string[];
}

interface OpenApiDocument {
  paths: Record<string, Record<string, Operation>>;
}

const HTTP_METHODS = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'options',
  'head',
  'trace',
]);

function document(): OpenApiDocument {
  return JSON.parse(
    readFileSync(
      resolve(process.cwd(), '../../packages/contracts/openapi/openapi.json'),
      'utf8',
    ),
  ) as OpenApiDocument;
}

function operation(
  spec: OpenApiDocument,
  method: string,
  path: string,
): Operation {
  const result = spec.paths[path]?.[method];
  expect(result, `${method.toUpperCase()} ${path} must exist`).toBeDefined();
  return result!;
}

describe('OpenAPI authorization scope contract', () => {
  it('gives every bearer operation a non-empty closed x-required-scopes list', () => {
    const spec = document();
    const offenders: string[] = [];

    for (const [path, item] of Object.entries(spec.paths)) {
      for (const [method, candidate] of Object.entries(item)) {
        if (!HTTP_METHODS.has(method)) continue;
        const bearer = candidate.security?.some((entry) => 'bearer' in entry);
        if (!bearer) continue;
        const scopes = candidate['x-required-scopes'];
        if (!Array.isArray(scopes) || scopes.length === 0) {
          offenders.push(`${method.toUpperCase()} ${path}: missing scopes`);
          continue;
        }
        for (const scope of scopes) {
          if (!AUTHORIZATION_SCOPES.includes(scope as never)) {
            offenders.push(`${method.toUpperCase()} ${path}: unknown ${scope}`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('locks independent review, ACK, compliance, and PII-bearing read scopes', () => {
    const spec = document();
    expect(
      operation(spec, 'post', '/api/v1/leads/{leadId}/sanctions-review')[
        'x-required-scopes'
      ],
    ).toEqual([
      'acquisition:review',
      'acquisition:identity:review',
    ]);
    expect(
      operation(spec, 'post', '/api/v1/events/ack')['x-required-scopes'],
    ).toEqual(['acquisition:event:ack']);
    expect(
      operation(spec, 'post', '/api/v1/deletion-requests')[
        'x-required-scopes'
      ],
    ).toEqual(['compliance:manage']);
    expect(
      operation(spec, 'get', '/api/v1/canonical-companies/{id}')[
        'x-required-scopes'
      ],
    ).toEqual(['acquisition:read', 'personal-data:read']);
    expect(
      operation(spec, 'post', '/api/v1/canonical-companies/{id}/guess-emails')[
        'x-required-scopes'
      ],
    ).toEqual([
      'acquisition:write',
      'personal-data:read',
      'compliance:manage',
    ]);
  });

  it('keeps infrastructure health probes public', () => {
    const spec = document();
    for (const path of [
      '/api/v1/health',
      '/api/v1/health/db',
      '/api/v1/health/live',
      '/api/v1/health/build',
      '/api/v1/health/ready',
    ]) {
      const candidate = operation(spec, 'get', path);
      expect(candidate.security ?? []).toEqual([]);
      expect(candidate['x-required-scopes']).toBeUndefined();
    }
  });
});
