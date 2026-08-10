import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const api = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../packages/contracts/openapi/openapi.json'), 'utf8'),
) as {
  paths: Record<string, Record<string, {
    responses?: Record<string, {
      content?: { 'application/json'?: { schema?: {
        properties?: { error?: { properties?: { code?: { enum?: string[] } } } };
      } } };
    }>;
  }>>;
};

const codes = (path: string, method: string, status: string): string[] | undefined =>
  api.paths[path]?.[method]?.responses?.[status]?.content?.['application/json']?.schema
    ?.properties?.error?.properties?.code?.enum;

describe('acquisition compliance error OpenAPI', () => {
  it('publishes every reachable Lead accept 404/409 result', () => {
    const accept = api.paths['/api/v1/leads/{leadId}/accept']?.post;
    expect(accept?.responses).toHaveProperty('404');
    expect(codes('/api/v1/leads/{leadId}/accept', 'post', '409')).toEqual([
      'SUPPRESSED',
      'INVALID_STATE',
      'SUPPRESSED_CONTACT_UNREACHABLE',
      'STORAGE_RIGHTS_NOT_GRANTED',
      'SANCTIONS_HOLD_UNRESOLVED',
      'CONFLICT',
    ]);
  });

  it('publishes only HTTP-reachable decision validation codes', () => {
    expect(codes('/api/v1/suppressions/{id}/decisions', 'post', '400')).toEqual([
      'VALIDATION_ERROR',
      'INVALID_REASON',
    ]);
  });
});
