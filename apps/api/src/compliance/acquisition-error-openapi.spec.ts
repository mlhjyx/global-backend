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
  it('publishes every reachable Lead accept 400/404/409 result', () => {
    const accept = api.paths['/api/v1/leads/{leadId}/accept']?.post;
    expect(codes('/api/v1/leads/{leadId}/accept', 'post', '400')).toEqual(['VALIDATION_ERROR']);
    expect(accept?.responses).toHaveProperty('404');
    expect(codes('/api/v1/leads/{leadId}/accept', 'post', '409')).toEqual([
      'SUPPRESSED',
      'INVALID_STATE',
      'SUPPRESSED_CONTACT_UNREACHABLE',
      'STORAGE_RIGHTS_NOT_GRANTED',
      'SANCTIONS_HOLD_UNRESOLVED',
      'IDENTITY_CONFLICT_OPEN',
      'IDENTITY_LEAD_CONFLICT',
      'IDENTITY_CHANGE_PENDING',
      'CONFLICT',
    ]);
  });

  it('publishes every reachable Lead reject 400/404/409 result', () => {
    const reject = api.paths['/api/v1/leads/{leadId}/reject']?.post;
    expect(codes('/api/v1/leads/{leadId}/reject', 'post', '400')).toEqual(['VALIDATION_ERROR']);
    expect(codes('/api/v1/leads/{leadId}/reject', 'post', '404')).toEqual(['NOT_FOUND']);
    expect(codes('/api/v1/leads/{leadId}/reject', 'post', '409')).toEqual([
      'SUPPRESSED',
      'INVALID_STATE',
      'CONFLICT',
    ]);
    expect(reject?.responses).toHaveProperty('200');
  });

  it('publishes only HTTP-reachable decision validation codes', () => {
    expect(codes('/api/v1/suppressions/{id}/decisions', 'post', '400')).toEqual([
      'VALIDATION_ERROR',
      'INVALID_REASON',
    ]);
  });
});
